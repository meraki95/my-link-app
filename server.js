// server.js (PostgreSQL + R2 + 링크트리)

// 기본 모듈
const express = require('express');
const path = require('path');
const session = require('express-session');
const multer = require('multer');
const bcrypt = require('bcrypt');

// DB (Postgres용 커스텀 래퍼: all/get/run/runInsert/init)
const db = require('./db');

// Cloudflare R2
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");

// ================== 환경 변수 ==================
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';
const ADMIN_PASSWORD_HASH = bcrypt.hashSync(ADMIN_PASSWORD, 10);
const SESSION_SECRET = process.env.SESSION_SECRET || 'your-super-secret-key';

// 파이썬 자동화 전용 API 키
const API_SECRET = process.env.API_SECRET || 'auto-news-secret';

// R2 설정
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL;

// R2 클라이언트
const R2 = new S3Client({
  region: "auto",
  endpoint: `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`.replace(
    '<ACCOUNT_ID>',
    R2_ACCOUNT_ID
  ),
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

// ================== Express 기본 설정 ==================
const app = express();
const port = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, 'public')));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
  })
);

// Multer: 메모리 스토리지
const upload = multer({ storage: multer.memoryStorage() });

// ================== 공통 미들웨어/헬퍼 ==================
function isLoggedIn(req, res, next) {
  if (req.session.loggedin) return next();
  res.redirect('/login');
}

// R2 업로드
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

// R2 삭제
const deleteFromR2 = async (imageUrl) => {
  if (!imageUrl) return;
  try {
    const key = new URL(imageUrl).pathname.substring(1);
    const command = new DeleteObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
    });
    await R2.send(command);
  } catch (error) {
    console.error("R2 이미지 삭제 실패:", error);
  }
};

// ================== 라우팅 ==================

// 메인 링크 페이지
app.get('/', (req, res) => {
  const linksSql = "SELECT * FROM links ORDER BY ordering ASC";
  const profileSql = "SELECT * FROM profile WHERE id = 1";

  Promise.all([
    new Promise((resolve, reject) =>
      db.all(linksSql, [], (err, rows) => (err ? reject(err) : resolve(rows)))
    ),
    new Promise((resolve, reject) =>
      db.get(profileSql, [], (err, row) => (err ? reject(err) : resolve(row)))
    ),
  ])
    .then(([links, profile]) => res.render('index', { links, profile }))
    .catch((err) => {
      console.error(err);
      res.status(500).send("서버 오류");
    });
});

// 클릭 카운트 + 리다이렉트
app.get('/click/:id', (req, res) => {
  const id = req.params.id;

  db.run(
    "UPDATE links SET clicks = clicks + 1 WHERE id = $1",
    [id],
    (err) => {
      if (err) console.error("클릭 수 증가 오류:", err);
    }
  );

  db.get(
    "SELECT url FROM links WHERE id = $1",
    [id],
    (err, row) => {
      if (err || !row) return res.status(404).send("링크를 찾을 수 없습니다.");
      res.redirect(row.url);
    }
  );
});

// 로그인/로그아웃
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

// 어드민 대시보드
app.get('/admin', isLoggedIn, (req, res) => {
  const linksSql =
    "SELECT *, (SELECT SUM(clicks) FROM links) AS total_clicks FROM links ORDER BY ordering ASC";
  const profileSql = "SELECT * FROM profile WHERE id = 1";

  Promise.all([
    new Promise((resolve, reject) =>
      db.all(linksSql, [], (err, rows) => (err ? reject(err) : resolve(rows)))
    ),
    new Promise((resolve, reject) =>
      db.get(profileSql, [], (err, row) => (err ? reject(err) : resolve(row)))
    ),
  ])
    .then(([links, profile]) => {
      const totalLinks = links.length;
      const totalClicks =
        links.length > 0 && links[0].total_clicks
          ? links[0].total_clicks
          : 0;
      res.render('admin', { links, profile, totalLinks, totalClicks });
    })
    .catch((err) => {
      console.error(err);
      res.status(500).send("서버 오류");
    });
});

// 프로필 업데이트
app.post(
  '/admin/update-profile',
  isLoggedIn,
  upload.single('profile_image'),
  async (req, res) => {
    const { username, description, currentImage } = req.body;
    let newImageUrl = currentImage;

    try {
      if (req.file) {
        newImageUrl = await uploadToR2(req.file);
        if (currentImage && currentImage !== '/default-profile.png') {
          await deleteFromR2(currentImage);
        }
      }

      db.run(
        "UPDATE profile SET username = $1, description = $2, profile_image_url = $3 WHERE id = 1",
        [username, description, newImageUrl],
        (err) => {
          if (err) {
            console.error("프로필 업데이트 오류:", err);
            return res.status(500).send("프로필 업데이트 오류");
          }
          res.redirect('/admin');
        }
      );
    } catch (e) {
      console.error(e);
      res.status(500).send("프로필 업데이트 오류");
    }
  }
);

// 링크 추가
app.post(
  '/admin/add',
  isLoggedIn,
  upload.single('image'),
  async (req, res) => {
    const { title, url } = req.body;

    try {
      const imageUrl = await uploadToR2(req.file);

      db.run(
        "INSERT INTO links (title, url, image) VALUES ($1, $2, $3)",
        [title, url, imageUrl],
        (err) => {
          if (err) {
            console.error("링크 추가 오류:", err);
            return res.status(500).send("링크 추가 오류");
          }
          res.redirect('/admin');
        }
      );
    } catch (e) {
      console.error(e);
      res.status(500).send("링크 추가 오류");
    }
  }
);

// 링크 수정 페이지
app.get('/admin/edit/:id', isLoggedIn, (req, res) => {
  db.get(
    "SELECT * FROM links WHERE id = $1",
    [req.params.id],
    (err, row) => {
      if (err || !row) return res.status(404).send("링크를 찾을 수 없습니다.");
      res.render('edit-link', { link: row });
    }
  );
});

// 링크 수정 처리
app.post(
  '/admin/edit/:id',
  isLoggedIn,
  upload.single('image'),
  async (req, res) => {
    const { title, url, currentImage } = req.body;
    let newImageUrl = currentImage;

    try {
      if (req.file) {
        newImageUrl = await uploadToR2(req.file);
        if (currentImage) {
          await deleteFromR2(currentImage);
        }
      }

      db.run(
        "UPDATE links SET title = $1, url = $2, image = $3 WHERE id = $4",
        [title, url, newImageUrl, req.params.id],
        (err) => {
          if (err) {
            console.error("링크 수정 오류:", err);
            return res.status(500).send("링크 수정 오류");
          }
          res.redirect('/admin');
        }
      );
    } catch (e) {
      console.error(e);
      res.status(500).send("링크 수정 오류");
    }
  }
);

// 링크 삭제
app.post('/admin/delete/:id', isLoggedIn, (req, res) => {
  const id = req.params.id;

  db.get(
    "SELECT image FROM links WHERE id = $1",
    [id],
    async (err, row) => {
      if (err) {
        console.error("링크 조회 오류:", err);
        return res.status(500).send("링크 조회 오류");
      }

      try {
        if (row && row.image) {
          await deleteFromR2(row.image);
        }

        db.run(
          "DELETE FROM links WHERE id = $1",
          [id],
          (err2) => {
            if (err2) {
              console.error("링크 삭제 오류:", err2);
              return res.status(500).send("링크 삭제 오류");
            }
            res.redirect('/admin');
          }
        );
      } catch (e) {
        console.error(e);
        res.status(500).send("링크 삭제 오류");
      }
    }
  );
});

// 링크 순서 변경
app.post('/admin/update-order', isLoggedIn, (req, res) => {
  const { order } = req.body;
  if (!order || !Array.isArray(order)) {
    return res.status(400).json({ success: false });
  }

  const cases = order
    .map((id, index) => `WHEN ${Number(id)} THEN ${index}`)
    .join(' ');

  const sql = `UPDATE links SET ordering = CASE id ${cases} END WHERE id IN (${order
    .map((id) => Number(id))
    .join(',')})`;

  db.run(sql, [], (err) => {
    if (err) {
      console.error("순서 업데이트 오류:", err);
      return res.status(500).json({ success: false });
    }
    res.json({ success: true });
  });
});

// 파이썬 자동화용 API: 링크 추가
app.post('/api/admin/links', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== API_SECRET) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const { title, url, image } = req.body;

    if (!title || !url) {
      return res.status(400).json({
        success: false,
        message: 'title과 url은 필수입니다.',
      });
    }

    db.runInsert(
      "INSERT INTO links (title, url, image) VALUES ($1, $2, $3) RETURNING id",
      [title, url, image || null],
      (err, id) => {
        if (err) {
          console.error('링크 추가 오류:', err);
          return res.status(500).json({ success: false, message: 'DB 오류' });
        }

        return res.json({
          success: true,
          id,
        });
      }
    );
  } catch (err) {
    console.error('API /api/admin/links 오류:', err);
    return res.status(500).json({ success: false, message: '서버 오류' });
  }
});

// 헬스체크/크론 핑
app.get('/cron-ping', async (req, res) => {
  try {
    res.send('OK');
  } catch (e) {
    console.error(e);
    res.status(500).send('ERROR');
  }
});

// ================== 서버 시작 (DB init 후) ==================
async function start() {
  try {
    await db.init(); // Postgres 테이블 생성 + 기본 프로필
    app.listen(port, () => {
      console.log(`서버가 http://localhost:${port} 에서 실행 중입니다.`);
    });
  } catch (e) {
    console.error('[SERVER] 초기화 실패:', e);
    process.exit(1);
  }
}

start();

module.exports = app;
