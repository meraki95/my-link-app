const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./links.db');

db.serialize(() => {
    // 'links' 테이블 (기존과 동일)
    db.run(`CREATE TABLE IF NOT EXISTS links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        image TEXT,
        clicks INTEGER DEFAULT 0,
        ordering INTEGER DEFAULT 0
    )`);

    // ✨ [NEW] 'profile' 테이블 생성
    db.run(`CREATE TABLE IF NOT EXISTS profile (
        id INTEGER PRIMARY KEY CHECK (id = 1), -- 항상 id가 1인 한 개의 행만 존재하도록 보장
        username TEXT NOT NULL,
        description TEXT,
        profile_image_url TEXT
    )`);

    // ✨ [NEW] 최초 실행 시 기본 프로필 데이터 삽입
    const defaultProfile = {
        username: '@MyProfile',
        description: '저의 모든 것을 이곳에서 확인하세요! 관리자 페이지에서 수정할 수 있습니다.',
        imageUrl: '/default-profile.png' // 기본 이미지 경로 (public 폴더에 이미지를 넣어두세요)
    };
    db.run(
        `INSERT OR IGNORE INTO profile (id, username, description, profile_image_url) VALUES (1, ?, ?, ?)`,
        [defaultProfile.username, defaultProfile.description, defaultProfile.imageUrl]
    );
});

module.exports = db;