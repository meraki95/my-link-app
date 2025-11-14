const express = require('express');
const path = require('path');
const db = require('./db');
const multer = require('multer');
const session = require('express-session');
const bcrypt = require('bcrypt');
const fs = require('fs');
const app = express();
const port = 3000;

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';
const ADMIN_PASSWORD_HASH = bcrypt.hashSync(ADMIN_PASSWORD, 10);
const SESSION_SECRET = process.env.SESSION_SECRET || 'your-super-secret-key';
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
    secret: SESSION_SECRET, // 환경 변수 사용
    resave: false,
    saveUninitialized: true,
}));

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage: storage });

function isLoggedIn(req, res, next) {
    if (req.session.loggedin) {
        next();
    } else {
        res.redirect('/login');
    }
}

// --- 라우팅 ---

app.get('/', (req, res) => {
    const linksSql = "SELECT * FROM links ORDER BY ordering ASC";
    const profileSql = "SELECT * FROM profile WHERE id = 1";

    Promise.all([
        new Promise((resolve, reject) => db.all(linksSql, [], (err, rows) => err ? reject(err) : resolve(rows))),
        new Promise((resolve, reject) => db.get(profileSql, [], (err, row) => err ? reject(err) : resolve(row)))
    ]).then(([links, profile]) => {
        res.render('index', { links, profile });
    }).catch(err => {
        console.error(err);
        res.status(500).send("서버 오류가 발생했습니다.");
    });
});

app.get('/click/:id', (req, res) => {
    const id = req.params.id;
    db.run("UPDATE links SET clicks = clicks + 1 WHERE id = ?", [id], (err) => {
        if (err) console.error("클릭 수 업데이트 실패:", err);
    });
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
app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/'));
});

app.get('/admin', isLoggedIn, (req, res) => {
    const linksSql = "SELECT *, (SELECT SUM(clicks) FROM links) as total_clicks FROM links ORDER BY ordering ASC";
    const profileSql = "SELECT * FROM profile WHERE id = 1";
    
    Promise.all([
        new Promise((resolve, reject) => db.all(linksSql, [], (err, rows) => err ? reject(err) : resolve(rows))),
        new Promise((resolve, reject) => db.get(profileSql, [], (err, row) => err ? reject(err) : resolve(row)))
    ]).then(([links, profile]) => {
        const totalLinks = links.length;
        const totalClicks = links.length > 0 && links[0].total_clicks ? links[0].total_clicks : 0;
        res.render('admin', { links, profile, totalLinks, totalClicks });
    }).catch(err => {
        console.error(err);
        res.status(500).send("서버 오류가 발생했습니다.");
    });
});

app.post('/admin/update-profile', isLoggedIn, upload.single('profile_image'), (req, res) => {
    const { username, description, currentImage } = req.body;
    const newImage = req.file ? `/uploads/${req.file.filename}` : currentImage;

    if (req.file && currentImage && currentImage !== '/default-profile.png') {
        const oldImagePath = path.join(__dirname, currentImage.substring(1));
        fs.unlink(oldImagePath, (err) => {
            if (err) console.error("기존 프로필 이미지 삭제 실패:", err);
        });
    }

    const sql = "UPDATE profile SET username = ?, description = ?, profile_image_url = ? WHERE id = 1";
    db.run(sql, [username, description, newImage], (err) => {
        if (err) {
            console.error(err);
            return res.status(500).send("프로필 업데이트 중 오류가 발생했습니다.");
        }
        res.redirect('/admin');
    });
});

app.post('/admin/add', isLoggedIn, upload.single('image'), (req, res) => {
    const { title, url } = req.body;
    const image = req.file ? `/uploads/${req.file.filename}` : null;
    db.run("INSERT INTO links (title, url, image) VALUES (?, ?, ?)", [title, url, image], (err) => {
        if (err) return res.status(500).send("링크 추가 오류");
        res.redirect('/admin');
    });
});

app.get('/admin/edit/:id', isLoggedIn, (req, res) => {
    db.get("SELECT * FROM links WHERE id = ?", [req.params.id], (err, row) => {
        if (err || !row) return res.status(404).send("링크를 찾을 수 없습니다.");
        res.render('edit-link', { link: row });
    });
});

app.post('/admin/edit/:id', isLoggedIn, upload.single('image'), (req, res) => {
    const { title, url, currentImage } = req.body;
    const newImage = req.file ? `/uploads/${req.file.filename}` : currentImage;

    if (req.file && currentImage) {
        const oldImagePath = path.join(__dirname, currentImage.substring(1));
        fs.unlink(oldImagePath, (err) => {
            if (err) console.error("기존 링크 이미지 삭제 실패:", err);
        });
    }

    const sql = "UPDATE links SET title = ?, url = ?, image = ? WHERE id = ?";
    db.run(sql, [title, url, newImage, req.params.id], (err) => {
        if (err) return res.status(500).send("링크 수정 오류");
        res.redirect('/admin');
    });
});

app.post('/admin/delete/:id', isLoggedIn, (req, res) => {
    const id = req.params.id;
    db.get("SELECT image FROM links WHERE id = ?", [id], (err, row) => {
        if (err) return res.status(500).send("링크 조회 오류");

        db.run("DELETE FROM links WHERE id = ?", id, (err) => {
            if (err) return res.status(500).send("링크 삭제 오류");

            if (row && row.image) {
                const imagePath = path.join(__dirname, row.image.substring(1));
                fs.unlink(imagePath, (err) => {
                    if (err) {
                        console.error("링크 이미지 파일 삭제 실패:", err);
                    }
                    res.redirect('/admin');
                });
            } else {
                res.redirect('/admin');
            }
        });
    });
});

app.post('/admin/update-order', isLoggedIn, (req, res) => {
    const { order } = req.body;
    if (!order || !Array.isArray(order)) {
        return res.status(400).json({ success: false, message: '잘못된 요청입니다.' });
    }
    const cases = order.map((id, index) => `WHEN ${id} THEN ${index}`).join(' ');
    const sql = `UPDATE links SET ordering = CASE id ${cases} END WHERE id IN (${order.join(',')})`;
    db.run(sql, (err) => {
        if (err) {
            console.error("순서 업데이트 실패:", err);
            return res.status(500).json({ success: false });
        }
        res.json({ success: true });
    });
});

app.listen(port, () => {
    console.log(`서버가 http://localhost:${port} 에서 실행 중입니다.`);
});