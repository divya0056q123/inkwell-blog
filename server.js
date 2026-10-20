const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
const jwt = require("jsonwebtoken");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const app = express();
const port = Number(process.env.PORT) || 3000;
const dataDirectory = path.join(__dirname, "data");
fs.mkdirSync(dataDirectory, { recursive: true });

const database = new Database(path.join(dataDirectory, "blog.db"));
database.pragma("journal_mode = WAL");
database.pragma("foreign_keys = ON");
database.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    bio TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'published')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS post_likes (
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (post_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS bookmarks (
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (post_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS posts_created_at_idx ON posts(created_at DESC);
  CREATE INDEX IF NOT EXISTS comments_post_id_idx ON comments(post_id);
`);

const userColumns = database.prepare("PRAGMA table_info(users)").all().map((column) => column.name);
const postColumns = database.prepare("PRAGMA table_info(posts)").all().map((column) => column.name);
if (!userColumns.includes("bio")) database.exec("ALTER TABLE users ADD COLUMN bio TEXT NOT NULL DEFAULT ''");
if (!postColumns.includes("tags")) database.exec("ALTER TABLE posts ADD COLUMN tags TEXT NOT NULL DEFAULT ''");
if (!postColumns.includes("status")) {
  database.exec("ALTER TABLE posts ADD COLUMN status TEXT NOT NULL DEFAULT 'published'");
}

const jwtSecret = process.env.JWT_SECRET || crypto.randomBytes(32).toString("hex");
if (!process.env.JWT_SECRET) {
  console.warn("JWT_SECRET is not set; using a temporary secret for this run.");
}

app.disable("x-powered-by");
app.use(helmet());
app.use(express.json({ limit: "20kb" }));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many attempts. Please try again in a few minutes." },
});

function createToken(user) {
  return jwt.sign({ sub: user.id, name: user.name }, jwtSecret, { expiresIn: "7d" });
}

function authenticate(req, res, next) {
  const authorization = req.get("authorization") || "";
  const [scheme, token] = authorization.split(" ");
  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({ error: "Please sign in to continue." });
  }
  try {
    const payload = jwt.verify(token, jwtSecret);
    const user = database
      .prepare("SELECT id, name, email, bio FROM users WHERE id = ?")
      .get(payload.sub);
    if (!user) return res.status(401).json({ error: "Your session is no longer valid." });
    req.user = user;
    return next();
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError || error instanceof jwt.TokenExpiredError) {
      return res.status(401).json({ error: "Your session has expired. Please sign in again." });
    }
    return next(error);
  }
}

function validateText(value, label, maxLength) {
  if (typeof value !== "string" || !value.trim()) {
    return `${label} is required.`;
  }
  if (value.trim().length > maxLength) {
    return `${label} must be ${maxLength} characters or fewer.`;
  }
  return null;
}

function postWithAuthor(postId) {
  return database.prepare(`
    SELECT posts.id, posts.title, posts.body, posts.tags, posts.status,
           posts.created_at, posts.updated_at,
           users.id AS author_id, users.name AS author,
           (SELECT COUNT(*) FROM comments WHERE comments.post_id = posts.id) AS comment_count,
           (SELECT COUNT(*) FROM post_likes WHERE post_likes.post_id = posts.id) AS like_count
    FROM posts
    JOIN users ON users.id = posts.user_id
    WHERE posts.id = ?
  `).get(postId);
}

function cleanTags(value) {
  if (typeof value !== "string") return null;
  const tags = [...new Set(value.split(",").map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
  if (tags.length > 8 || tags.some((tag) => tag.length > 24 || !/^[a-z0-9 -]+$/.test(tag))) {
    return null;
  }
  return tags.join(", ");
}

function parsePostInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { error: "Post data must be a JSON object." };
  }
  const titleError = validateText(input.title, "Title", 140);
  const status = input.status === undefined ? "published" : input.status;
  const body = input.body === undefined ? "" : input.body;
  const bodyError = typeof body !== "string"
    ? "Post must be text."
    : body.length > 20000
      ? "Post must be 20000 characters or fewer."
      : status === "draft"
        ? null
        : validateText(body, "Post", 20000);
  const tags = cleanTags(input.tags === undefined ? "" : input.tags);
  if (!titleError && !["draft", "published"].includes(status)) {
    return { error: "Status must be either draft or published." };
  }
  if (titleError || bodyError || tags === null) {
    return {
      error: titleError || bodyError || "Use up to 8 tags (24 characters each; letters, numbers, spaces, and hyphens).",
    };
  }
  return { title: input.title.trim(), body: body.trim(), tags, status };
}

function visiblePost(postId, userId) {
  return database.prepare(`
    SELECT id, user_id, status FROM posts
    WHERE id = ? AND (status = 'published' OR user_id = ?)
  `).get(postId, userId || -1);
}

function addViewerState(post, userId) {
  if (!post) return post;
  const viewer = userId ? database.prepare(`
    SELECT EXISTS(SELECT 1 FROM post_likes WHERE post_id = ? AND user_id = ?) AS liked,
           EXISTS(SELECT 1 FROM bookmarks WHERE post_id = ? AND user_id = ?) AS bookmarked
  `).get(post.id, userId, post.id, userId) : { liked: 0, bookmarked: 0 };
  return { ...post, liked: Boolean(viewer.liked), bookmarked: Boolean(viewer.bookmarked) };
}

app.post("/api/auth/register", authLimiter, async (req, res, next) => {
  const nameError = validateText(req.body.name, "Name", 60);
  const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const password = req.body.password;
  if (nameError) return res.status(400).json({ error: nameError });
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Enter a valid email address." });
  }
  if (typeof password !== "string" || password.length < 8 || password.length > 128) {
    return res.status(400).json({ error: "Password must be between 8 and 128 characters." });
  }
  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const result = database
      .prepare("INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)")
      .run(req.body.name.trim(), email, passwordHash);
    const user = { id: Number(result.lastInsertRowid), name: req.body.name.trim(), email, bio: "" };
    return res.status(201).json({ token: createToken(user), user });
  } catch (error) {
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
      return res.status(409).json({ error: "An account with that email already exists." });
    }
    return next(error);
  }
});

app.post("/api/auth/login", authLimiter, async (req, res, next) => {
  const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const password = req.body.password;
  if (!email || typeof password !== "string") {
    return res.status(400).json({ error: "Email and password are required." });
  }
  try {
    const account = database
      .prepare("SELECT id, name, email, password_hash FROM users WHERE email = ?")
      .get(email);
    const validPassword = account
      ? await bcrypt.compare(password, account.password_hash)
      : false;
    if (!validPassword) return res.status(401).json({ error: "Email or password is incorrect." });
    const user = { id: account.id, name: account.name, email: account.email, bio: account.bio };
    return res.json({ token: createToken(user), user });
  } catch (error) {
    return next(error);
  }
});

app.get("/api/auth/me", authenticate, (req, res) => res.json({ user: req.user }));

app.put("/api/auth/me", authenticate, (req, res) => {
  const nameError = validateText(req.body.name, "Name", 60);
  if (nameError) return res.status(400).json({ error: nameError });
  if (typeof req.body.bio !== "string" || req.body.bio.length > 280) {
    return res.status(400).json({ error: "Bio must be 280 characters or fewer." });
  }
  database.prepare("UPDATE users SET name = ?, bio = ? WHERE id = ?")
    .run(req.body.name.trim(), req.body.bio.trim(), req.user.id);
  return res.json({
    user: database.prepare("SELECT id, name, email, bio FROM users WHERE id = ?").get(req.user.id),
  });
});

app.get("/api/posts", (req, res) => {
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  const tag = typeof req.query.tag === "string" ? req.query.tag.trim().toLowerCase() : "";
  const posts = database.prepare(`
    SELECT posts.id, posts.title, posts.body, posts.tags, posts.status,
           posts.created_at, posts.updated_at,
           users.id AS author_id, users.name AS author,
           (SELECT COUNT(*) FROM comments WHERE comments.post_id = posts.id) AS comment_count,
           (SELECT COUNT(*) FROM post_likes WHERE post_likes.post_id = posts.id) AS like_count
    FROM posts
    JOIN users ON users.id = posts.user_id
    WHERE posts.status = 'published'
      AND (? = '' OR posts.title LIKE ? OR posts.body LIKE ? OR users.name LIKE ?)
      AND (? = '' OR EXISTS (
        SELECT 1 FROM json_each('["' || replace(replace(posts.tags, ', ', ','), ',', '","') || '"]')
        WHERE lower(value) = ?
      ))
    ORDER BY posts.created_at DESC, posts.id DESC
  `).all(search, `%${search}%`, `%${search}%`, `%${search}%`, tag, tag)
    .map((post) => addViewerState(post, optionalUserId(req)));
  return res.json({ posts });
});

function optionalUserId(req) {
  const authorization = req.get("authorization") || "";
  const [scheme, token] = authorization.split(" ");
  if (scheme !== "Bearer" || !token) return null;
  try {
    const payload = jwt.verify(token, jwtSecret);
    return database.prepare("SELECT id FROM users WHERE id = ?").get(payload.sub)?.id || null;
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError || error instanceof jwt.TokenExpiredError) return null;
    throw error;
  }
}

app.get("/api/tags", (_req, res) => {
  const tags = database.prepare("SELECT tags FROM posts WHERE status = 'published' AND tags != ''")
    .all().flatMap((row) => row.tags.split(",").map((tag) => tag.trim()))
    .filter(Boolean);
  return res.json({ tags: [...new Set(tags)].sort() });
});

app.get("/api/users/:id", (req, res) => {
  const user = database.prepare(`
    SELECT id, name, bio, created_at FROM users WHERE id = ?
  `).get(req.params.id);
  if (!user) return res.status(404).json({ error: "Writer not found." });
  const posts = database.prepare(`
    SELECT posts.id, posts.title, posts.body, posts.tags, posts.status,
           posts.created_at, posts.updated_at,
           users.id AS author_id, users.name AS author,
           (SELECT COUNT(*) FROM comments WHERE comments.post_id = posts.id) AS comment_count,
           (SELECT COUNT(*) FROM post_likes WHERE post_likes.post_id = posts.id) AS like_count
    FROM posts JOIN users ON users.id = posts.user_id
    WHERE posts.user_id = ? AND posts.status = 'published'
    ORDER BY posts.created_at DESC, posts.id DESC
  `).all(user.id).map((post) => addViewerState(post, optionalUserId(req)));
  return res.json({ user, posts });
});

app.get("/api/me/posts", authenticate, (req, res) => {
  const status = req.query.status === "draft" ? "draft" : "published";
  const posts = database.prepare(`
    SELECT posts.id, posts.title, posts.body, posts.tags, posts.status,
           posts.created_at, posts.updated_at,
           users.id AS author_id, users.name AS author,
           (SELECT COUNT(*) FROM comments WHERE comments.post_id = posts.id) AS comment_count,
           (SELECT COUNT(*) FROM post_likes WHERE post_likes.post_id = posts.id) AS like_count
    FROM posts
    JOIN users ON users.id = posts.user_id
    WHERE posts.user_id = ? AND posts.status = ?
    ORDER BY posts.updated_at DESC, posts.id DESC
  `).all(req.user.id, status);
  return res.json({ posts: posts.map((post) => addViewerState(post, req.user.id)) });
});

app.get("/api/me/bookmarks", authenticate, (req, res) => {
  const posts = database.prepare(`
    SELECT posts.id, posts.title, posts.body, posts.tags, posts.status,
           posts.created_at, posts.updated_at,
           users.id AS author_id, users.name AS author,
           (SELECT COUNT(*) FROM comments WHERE comments.post_id = posts.id) AS comment_count,
           (SELECT COUNT(*) FROM post_likes WHERE post_likes.post_id = posts.id) AS like_count
    FROM bookmarks JOIN posts ON posts.id = bookmarks.post_id
    JOIN users ON users.id = posts.user_id
    WHERE bookmarks.user_id = ? AND posts.status = 'published'
    ORDER BY bookmarks.created_at DESC
  `).all(req.user.id);
  return res.json({ posts: posts.map((post) => addViewerState(post, req.user.id)) });
});

app.get("/api/posts/:id", (req, res) => {
  const userId = optionalUserId(req);
  const access = visiblePost(Number(req.params.id), userId);
  if (!access) return res.status(404).json({ error: "Post not found." });
  const post = addViewerState(postWithAuthor(Number(req.params.id)), userId);
  if (!post) return res.status(404).json({ error: "Post not found." });
  const comments = database.prepare(`
    SELECT comments.id, comments.body, comments.created_at,
           users.id AS author_id, users.name AS author
    FROM comments
    JOIN users ON users.id = comments.user_id
    WHERE comments.post_id = ?
    ORDER BY comments.created_at ASC, comments.id ASC
  `).all(post.id);
  return res.json({ post: { ...post, comments } });
});

app.post("/api/posts", authenticate, (req, res) => {
  const input = parsePostInput(req.body);
  if (input.error) return res.status(400).json({ error: input.error });
  const result = database.prepare(
    "INSERT INTO posts (user_id, title, body, tags, status) VALUES (?, ?, ?, ?, ?)"
  ).run(req.user.id, input.title, input.body, input.tags, input.status);
  return res.status(201).json({ post: postWithAuthor(Number(result.lastInsertRowid)) });
});

app.put("/api/posts/:id", authenticate, (req, res) => {
  const input = parsePostInput(req.body);
  if (input.error) return res.status(400).json({ error: input.error });
  const post = database.prepare("SELECT id, user_id FROM posts WHERE id = ?").get(req.params.id);
  if (!post) return res.status(404).json({ error: "Post not found." });
  if (post.user_id !== req.user.id) {
    return res.status(403).json({ error: "You can only edit your own posts." });
  }
  database.prepare(`
    UPDATE posts SET title = ?, body = ?, tags = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(input.title, input.body, input.tags, input.status, post.id);
  return res.json({ post: postWithAuthor(post.id) });
});

app.delete("/api/posts/:id", authenticate, (req, res) => {
  const post = database.prepare("SELECT id, user_id FROM posts WHERE id = ?").get(req.params.id);
  if (!post) return res.status(404).json({ error: "Post not found." });
  if (post.user_id !== req.user.id) {
    return res.status(403).json({ error: "You can only delete your own posts." });
  }
  database.prepare("DELETE FROM posts WHERE id = ?").run(post.id);
  return res.status(204).end();
});

app.post("/api/posts/:id/comments", authenticate, (req, res) => {
  const bodyError = validateText(req.body.body, "Comment", 2000);
  if (bodyError) return res.status(400).json({ error: bodyError });
  const post = database.prepare("SELECT id FROM posts WHERE id = ? AND status = 'published'").get(req.params.id);
  if (!post) return res.status(404).json({ error: "Post not found." });
  const result = database.prepare(
    "INSERT INTO comments (post_id, user_id, body) VALUES (?, ?, ?)"
  ).run(post.id, req.user.id, req.body.body.trim());
  const comment = database.prepare(`
    SELECT comments.id, comments.body, comments.created_at,
           users.id AS author_id, users.name AS author
    FROM comments JOIN users ON users.id = comments.user_id
    WHERE comments.id = ?
  `).get(Number(result.lastInsertRowid));
  return res.status(201).json({ comment });
});

app.put("/api/posts/:id/like", authenticate, (req, res) => {
  const post = database.prepare("SELECT id FROM posts WHERE id = ? AND status = 'published'").get(req.params.id);
  if (!post) return res.status(404).json({ error: "Post not found." });
  database.prepare("INSERT OR IGNORE INTO post_likes (post_id, user_id) VALUES (?, ?)")
    .run(post.id, req.user.id);
  const likeCount = database.prepare("SELECT COUNT(*) AS count FROM post_likes WHERE post_id = ?")
    .get(post.id).count;
  return res.json({ liked: true, like_count: likeCount });
});

app.delete("/api/posts/:id/like", authenticate, (req, res) => {
  database.prepare("DELETE FROM post_likes WHERE post_id = ? AND user_id = ?")
    .run(req.params.id, req.user.id);
  const likeCount = database.prepare("SELECT COUNT(*) AS count FROM post_likes WHERE post_id = ?")
    .get(req.params.id).count;
  return res.json({ liked: false, like_count: likeCount });
});

app.put("/api/posts/:id/bookmark", authenticate, (req, res) => {
  const post = database.prepare("SELECT id FROM posts WHERE id = ? AND status = 'published'").get(req.params.id);
  if (!post) return res.status(404).json({ error: "Post not found." });
  database.prepare("INSERT OR IGNORE INTO bookmarks (post_id, user_id) VALUES (?, ?)")
    .run(post.id, req.user.id);
  return res.json({ bookmarked: true });
});

app.delete("/api/posts/:id/bookmark", authenticate, (req, res) => {
  database.prepare("DELETE FROM bookmarks WHERE post_id = ? AND user_id = ?")
    .run(req.params.id, req.user.id);
  return res.json({ bookmarked: false });
});

app.delete("/api/comments/:id", authenticate, (req, res) => {
  const comment = database.prepare(`
    SELECT comments.id, comments.user_id, posts.user_id AS post_author_id
    FROM comments JOIN posts ON posts.id = comments.post_id
    WHERE comments.id = ?
  `).get(req.params.id);
  if (!comment) return res.status(404).json({ error: "Comment not found." });
  if (comment.user_id !== req.user.id && comment.post_author_id !== req.user.id) {
    return res.status(403).json({ error: "You cannot delete this comment." });
  }
  database.prepare("DELETE FROM comments WHERE id = ?").run(comment.id);
  return res.status(204).end();
});

app.use("/api", (_req, res) => res.status(404).json({ error: "API endpoint not found." }));
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.use((error, _req, res, _next) => {
  console.error(error);
  if (res.headersSent) return;
  return res.status(500).json({ error: "Something went wrong. Please try again." });
});

const server = app.listen(port, () => {
  console.log(`Inkwell is running at http://localhost:${port}`);
});

function shutdown() {
  server.close(() => {
    database.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
