# Inkwell

A small full-stack blogging platform for publishing stories and having conversations around them.

## Features

- Create an account and sign in with a hashed password.
- Browse and search published stories.
- Create, edit, and delete your own posts.
- Save unpublished drafts and publish them when they are ready.
- Add topic tags and filter stories by topic.
- Like and bookmark published stories.
- Public author profiles with editable names and bios.
- Read and add comments; comment authors and post authors can remove comments.
- Responsive layout for desktop and mobile.
- Separate, bookmarkable pages for the journal, account access, writing, and each story.
- REST API backed by a local SQLite database.

## Run locally

Requires Node.js 18 or newer.

```sh
npm install
```

Set a long, random signing secret before starting the server. In PowerShell:

```powershell
$env:JWT_SECRET = "replace-this-with-a-long-random-secret"
npm start
```

Open <http://localhost:3000>. The app has separate pages at `/`, `/login`, `/register`, `/write`, `/posts/:id` (including `/posts/:id/edit`), `/profile/:id`, `/me`, `/bookmarks`, and `/settings`. The SQLite database is created at `data/blog.db` the first time the server starts; existing databases are upgraded automatically when the server starts. Set `PORT` to change the server port.

For development with automatic server restarts, use `npm run dev`.

## REST API

All request and response bodies are JSON. Protected endpoints use `Authorization: Bearer <token>`.

| Method | Endpoint | Access | Description |
| --- | --- | --- | --- |
| `POST` | `/api/auth/register` | Public | Register with `name`, `email`, and `password` |
| `POST` | `/api/auth/login` | Public | Sign in with `email` and `password` |
| `GET` | `/api/auth/me` | Signed in | Return the current account |
| `PUT` | `/api/auth/me` | Signed in | Update account name and bio |
| `GET` | `/api/posts?search=...&tag=...` | Public | List published stories with filters, likes, and viewer state |
| `GET` | `/api/tags` | Public | List available published-story tags |
| `GET` | `/api/posts/:id` | Public | Get one story and its comments |
| `POST` | `/api/posts` | Signed in | Create a story with `title`, `body`, `tags`, and `status` |
| `PUT` | `/api/posts/:id` | Story author | Update a story, tags, or publishing status |
| `DELETE` | `/api/posts/:id` | Story author | Delete a story and its comments |
| `PUT` / `DELETE` | `/api/posts/:id/like` | Signed in | Like or unlike a published story |
| `PUT` / `DELETE` | `/api/posts/:id/bookmark` | Signed in | Save or remove a published story |
| `POST` | `/api/posts/:id/comments` | Signed in | Add a comment with `body` |
| `DELETE` | `/api/comments/:id` | Comment or story author | Remove a comment |
| `GET` | `/api/users/:id` | Public | Get a writer profile and published stories |
| `GET` | `/api/me/posts?status=draft` | Signed in | List your own published stories or drafts |
| `GET` | `/api/me/bookmarks` | Signed in | List your saved published stories |

Run `npm run check` for JavaScript syntax checks.
