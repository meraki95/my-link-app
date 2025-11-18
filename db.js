// db.js (PostgreSQL 버전)
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL, // Render Postgres의 URL
    ssl: { rejectUnauthorized: false },        // Render/무료 호스팅에서 자주 쓰는 옵션
});

// 공통 쿼리 함수
function query(sql, params = [], cb) {
    pool.query(sql, params)
        .then(result => cb(null, result))
        .catch(err => cb(err));
}

// sqlite 스타일 흉내: all / get / run
function all(sql, params, cb) {
    query(sql, params, (err, result) => {
        if (err) return cb(err);
        cb(null, result.rows);
    });
}

function get(sql, params, cb) {
    query(sql, params, (err, result) => {
        if (err) return cb(err);
        cb(null, result.rows[0] || null);
    });
}

// INSERT/UPDATE/DELETE용
function run(sql, params, cb) {
    query(sql, params, (err, result) => {
        if (err) return cb && cb(err);
        // sqlite의 this.changes 비슷하게 rowCount만 넘겨줌
        cb && cb(null, { rowCount: result.rowCount });
    });
}

// INSERT + id까지 받고 싶을 때용
function runInsert(sql, params, cb) {
    // 반드시 SQL 끝에 "RETURNING id"가 있어야 함
    query(sql, params, (err, result) => {
        if (err) return cb(err);
        const row = result.rows[0];
        cb(null, row && row.id);
    });
}

// 테이블 초기화 (애플리케이션 시작 시 한 번 호출)
async function init() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // links 테이블
        await client.query(`
            CREATE TABLE IF NOT EXISTS links (
                id SERIAL PRIMARY KEY,
                title TEXT NOT NULL,
                url TEXT NOT NULL,
                image TEXT,
                clicks INTEGER DEFAULT 0,
                ordering INTEGER DEFAULT 0
            );
        `);

        // profile 테이블
        await client.query(`
            CREATE TABLE IF NOT EXISTS profile (
                id INTEGER PRIMARY KEY,
                username TEXT NOT NULL,
                description TEXT,
                profile_image_url TEXT
            );
        `);

        // 기본 프로필이 없으면 삽입
        await client.query(
            `
            INSERT INTO profile (id, username, description, profile_image_url)
            VALUES (1, $1, $2, $3)
            ON CONFLICT (id) DO NOTHING;
            `,
            [
                '@MyProfile',
                '저의 모든 것을 이곳에서 확인하세요! 관리자 페이지에서 수정할 수 있습니다.',
                '/default-profile.png',
            ]
        );

        await client.query('COMMIT');
        console.log('[DB] PostgreSQL 초기화 완료');
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('[DB] 초기화 실패:', e);
    } finally {
        client.release();
    }
}

module.exports = {
    all,
    get,
    run,
    runInsert,
    init,
};
