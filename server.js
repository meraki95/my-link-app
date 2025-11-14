const express = require('express');
const path = require('path');
const db = require('./db');
const multer = require('multer');
const session = require('express-session');
const bcrypt = require('bcrypt');
// ✨ [NEW] AWS S3 클라이언트 라이브러리 추가
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");

// --- 환경 변수 설정 ---
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';
const ADMIN_PASSWORD_HASH = bcrypt.hashSync(ADMIN_PASSWORD, 10);
const SESSION_SECRET = process.env.SESSION_SECRET || 'your-super-secret-key';

// ✨ [NEW] R2 접속 정보 환경 변수에서 가져오기
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL;

// ✨ [NEW] R2 클라이언트 설정
const R2 = new S3Client({
    region: "auto",
    endpoint: `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`.replace('<ACCOUNT_ID>', R2_ACCOUNT_ID),
    credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
});

const app = express();
const port = 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
// '/uploads' 경로는 이제 필요 없으므로 주석 처리하거나 삭제해도 됩니다.
// app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
}));

// ✨ [MODIFIED] Multer 설정을 디스크가 아닌 메모리 스토리지로 변경
const upload = multer({ storage: multer.memoryStorage() });

// --- R2 헬퍼 함수 ---
const uploadToR2 = async (file) => {
    if (!file) return null;
    const fileName = `${Date.now()}-${file.originalname}`;
    const command = new PutObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: fileName,
        Body: file.buffer,
        ContentType: file.mimetype,
    });
    await R2.send(command);
    return `https://${R2_PUBLIC_URL}/${fileName}`;
};

const deleteFromR2 = async (imageUrl) => {
    if (!imageUrl) return;
    try {
        const key = new URL(imageUrl).pathname.substring(1); // URL에서 파일 이름(key) 추출
        const command = new DeleteObjectCommand({
            Bucket: R2_BUCKET_NAME,
            Key: key,
        });
        await R2.send(command);
    } catch (error) {
        console.error("R2 이미지 삭제 실패:", error);
    }
};
    
// --- 라우팅 ---
// (기존 코드에서 파일 처리 로직만 R2 헬퍼 함수를 사용하도록 수정)

app.get('/', (req, res) => {
    const linksSql = "SELECT * FROM links ORDER BY ordering ASC";
    const profileSql = "SELECT * FROM profile WHERE id = 1";
    Promise.all([
        new Promise((resolve, reject) => db.all(linksSql, [], (err, rows) => err ? reject(err) : resolve(rows))),
        new Promise((resolve, reject) => db.get(profileSql, [], (err, row) => err ? reject(err) : resolve(row)))
    ]).then(([links, profile]) => res.render('index', { links, profile }))
      .catch(err => res.status(500).send("서버 오류"));
});

app.get('/click/:id', (req, res) => {
    const id = req.params.id;
    db.run("UPDATE links SET clicks = clicks + 1 WHERE id = ?", [id]);
    db.get("SELECT url FROM links WHERE id = ?", [id], (err, row) => {
        if (err || !row) return res.status(404).send("링크를 찾을 수 없습니다.");
        res.redirect(row.url);
    });
});

app.get('/login', (req, res) => res.render('login', { error: null }));
app.post('/login', (req, res) => {
    if (bcrypt.compareSync(req.body.password, ADMIN_PASSWORD_HASH)) {
        req.session.loggedin = true;
        res.redirect('/admin');
    } else {
        res.render('login', { error: '비밀번호가 올바르지 않습니다.' });
    }
});
app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/')));

app.get('/admin', (req, res) => {
    // ... admin 페이지 로직은 변경 없음 ...
    const linksSql = "SELECT *, (SELECT SUM(clicks) FROM links) as total_clicks FROM links ORDER BY ordering ASC";
    const profileSql = "SELECT * FROM profile WHERE id = 1";
    Promise.all([
        new Promise((resolve, reject) => db.all(linksSql, [], (err, rows) => err ? reject(err) : resolve(rows))),
        new Promise((resolve, reject) => db.get(profileSql, [], (err, row) => err ? reject(err) : resolve(row)))
    ]).then(([links, profile]) => {
        const totalLinks = links.length;
        const totalClicks = links.length > 0 && links[0].total_clicks ? links[0].total_clicks : 0;
        res.render('admin', { links, profile, totalLinks, totalClicks });
    }).catch(err => res.status(500).send("서버 오류"));
});

app.post('/admin/update-profile', isLoggedIn, upload.single('profile_image'), async (req, res) => {
    const { username, description, currentImage } = req.body;
    let newImageUrl = currentImage;
    if (req.file) {
        newImageUrl = await uploadToR2(req.file);
        if (currentImage && currentImage !== '/default-profile.png') {
            await deleteFromR2(currentImage);
        }
    }
    db.run("UPDATE profile SET username = ?, description = ?, profile_image_url = ? WHERE id = 1", [username, description, newImageUrl], (err) => {
        if (err) return res.status(500).send("프로필 업데이트 오류");
        res.redirect('/admin');
    });
});

app.post('/admin/add', isLoggedIn, upload.single('image'), async (req, res) => {
    const { title, url } = req.body;
    const imageUrl = await uploadToR2(req.file);
    db.run("INSERT INTO links (title, url, image) VALUES (?, ?, ?)", [title, url, imageUrl], (err) => {
        if (err) return res.status(500).send("링크 추가 오류");
        res.redirect('/admin');
    });
});

app.get('/admin/edit/:id', (req, res) => {
    // ... edit 페이지 로직은 변경 없음 ...
    db.get("SELECT * FROM links WHERE id = ?", [req.params.id], (err, row) => {
        if (err || !row) return res.status(404).send("링크를 찾을 수 없습니다.");
        res.render('edit-link', { link: row });
    });
});

app.post('/admin/edit/:id', isLoggedIn, upload.single('image'), async (req, res) => {
    const { title, url, currentImage } = req.body;
    let newImageUrl = currentImage;
    if (req.file) {
        newImageUrl = await uploadToR2(req.file);
        if (currentImage) {
            await deleteFromR2(currentImage);
        }
    }
    db.run("UPDATE links SET title = ?, url = ?, image = ? WHERE id = ?", [title, url, newImageUrl, req.params.id], (err) => {
        if (err) return res.status(500).send("링크 수정 오류");
        res.redirect('/admin');
    });
});

app.post('/admin/delete/:id', isLoggedIn, (req, res) => {
    const id = req.params.id;
    db.get("SELECT image FROM links WHERE id = ?", [id], async (err, row) => {
        if (err) return res.status(500).send("링크 조회 오류");
        if (row && row.image) {
            await deleteFromR2(row.image);
        }
        db.run("DELETE FROM links WHERE id = ?", id, (err) => {
            if (err) return res.status(500).send("링크 삭제 오류");
            res.redirect('/admin');
        });
    });
});

app.post('/admin/update-order', (req, res) => {
    // ... 순서 변경 로직은 변경 없음 ...
    const { order } = req.body;
    if (!order || !Array.isArray(order)) return res.status(400).json({ success: false });
    const cases = order.map((id, index) => `WHEN ${id} THEN ${index}`).join(' ');
    const sql = `UPDATE links SET ordering = CASE id ${cases} END WHERE id IN (${order.join(',')})`;
    db.run(sql, (err) => {
        if (err) return res.status(500).json({ success: false });
        res.json({ success: true });
    });
});

app.listen(port, () => {
    console.log(`서버가 http://localhost:${port} 에서 실행 중입니다.`);
});