const state = {
  token: localStorage.getItem("inkwell-token"),
  user: null,
  search: new URLSearchParams(location.search).get("search") || "",
  tag: new URLSearchParams(location.search).get("tag") || "",
};

const app = document.querySelector("#app");
const elements = {
  welcome: document.querySelector("#welcome-label"),
  signIn: document.querySelector("#sign-in-link"),
  signOut: document.querySelector("#sign-out"),
  write: document.querySelector("#write-link"),
  myStories: document.querySelector("#my-stories-link"),
  bookmarks: document.querySelector("#bookmarks-link"),
  profile: document.querySelector("#profile-link"),
  toast: document.querySelector("#toast"),
};

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function formatDate(value) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" })
    .format(new Date(`${value.replace(" ", "T")}Z`));
}

function excerpt(value, limit = 190) {
  const text = value.trim();
  return text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  clearTimeout(showToast.timeout);
  showToast.timeout = setTimeout(() => elements.toast.classList.remove("show"), 2800);
}

async function api(url, options = {}) {
  const headers = { "Content-Type": "application/json", ...options.headers };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  let response;
  try {
    response = await fetch(url, { ...options, headers });
  } catch {
    throw new Error("Could not reach Inkwell. Check that the app server is running and try again.");
  }
  if (response.status === 204) return null;
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && state.token && !url.startsWith("/api/auth/login")) {
      signOut(false);
    }
    throw new Error(data.error || "The request could not be completed.");
  }
  return data;
}

function updateHeader() {
  elements.welcome.textContent = state.user ? `Hello, ${state.user.name}` : "";
  elements.welcome.classList.toggle("hidden", !state.user);
  elements.signIn.classList.toggle("hidden", Boolean(state.user));
  elements.signOut.classList.toggle("hidden", !state.user);
  elements.myStories.classList.toggle("hidden", !state.user);
  elements.bookmarks.classList.toggle("hidden", !state.user);
  elements.profile.classList.toggle("hidden", !state.user);
  elements.write.textContent = state.user ? "Write a story ↗" : "Start writing ↗";
}

function signOut(notify = true) {
  localStorage.removeItem("inkwell-token");
  state.token = null;
  state.user = null;
  updateHeader();
  if (notify) {
    location.assign("/");
  }
}

function storyCard(post) {
  const isOwner = state.user && state.user.id === post.author_id;
  return `
    <article class="story-card">
      <div class="story-meta"><span class="avatar">${escapeHtml(post.author.slice(0, 1))}</span><a href="/profile/${post.author_id}">${escapeHtml(post.author)}</a><span class="meta-dot">·</span><time>${formatDate(post.created_at)}</time></div>
      <a class="story-title" href="/posts/${post.id}">${escapeHtml(post.title)}</a>
      <p class="story-excerpt">${escapeHtml(excerpt(post.body))}</p>
      <div class="tag-list">${post.tags ? post.tags.split(",").map((tag) => `<a class="tag-chip" href="/?tag=${encodeURIComponent(tag.trim())}">${escapeHtml(tag.trim())}</a>`).join("") : ""}</div>
      <div class="story-footer"><span>${post.comment_count} ${post.comment_count === 1 ? "comment" : "comments"} · ${post.like_count} ${post.like_count === 1 ? "like" : "likes"}${post.status === "draft" ? ' · <span class="status-pill">Draft</span>' : ""}</span>
        <span class="story-tools">
          ${post.status === "published" ? `<button class="mini-button" type="button" data-like-post="${post.id}" aria-pressed="${post.liked}">${post.liked ? "♥ Liked" : "♡ Like"}</button><button class="mini-button" type="button" data-bookmark-post="${post.id}" aria-pressed="${post.bookmarked}">${post.bookmarked ? "Saved" : "Bookmark"}</button>` : ""}
          ${isOwner ? `<a class="mini-button" href="/posts/${post.id}/edit">Edit</a><button class="mini-button" type="button" data-delete-post="${post.id}">Delete</button>` : ""}
        </span>
      </div>
    </article>`;
}

async function renderHome() {
  app.innerHTML = `
    <section class="hero">
      <p class="eyebrow"><span class="eyebrow-dot"></span> A place for your point of view</p>
      <h1>Ideas are better<br>when <em>shared.</em></h1>
      <p class="hero-copy">A little space for big thoughts, small discoveries, and everything in between.</p>
      <a class="text-link" href="#stories">Explore the stories <span aria-hidden="true">↓</span></a>
      <div class="hero-art" aria-hidden="true"><div class="art-circle"></div><div class="art-sun"></div><span class="art-letter">i</span><span class="art-caption">YOUR NEXT<br>GOOD IDEA</span></div>
    </section>
    <section class="stories-section" id="stories">
      <div class="section-heading">
        <div><p class="eyebrow">THE INKWELL JOURNAL</p><h2>Fresh from the page<span class="heading-period">.</span></h2></div>
        <div class="story-filters">
          <label class="search-field"><span class="sr-only">Search stories</span><span aria-hidden="true">⌕</span><input id="search-input" type="search" placeholder="Find a story" value="${escapeHtml(state.search)}" autocomplete="off"></label>
          <label class="filter-label">Topic <select id="tag-filter"><option value="">All topics</option></select></label>
        </div>
      </div>
      <div class="stories-layout">
        <div class="story-list" id="story-list" aria-live="polite"><p class="empty-state">Loading stories…</p></div>
        <aside class="side-note"><span class="note-star" aria-hidden="true">✳</span><p class="eyebrow">A NOTE TO READERS</p><p>Good writing starts with paying attention. Thanks for being here.</p><div class="note-rule"></div><span class="note-signature">The Inkwell team</span></aside>
      </div>
    </section>`;

  const list = document.querySelector("#story-list");
  try {
    const query = new URLSearchParams();
    if (state.search) query.set("search", state.search);
    if (state.tag) query.set("tag", state.tag);
    const data = await api(`/api/posts?${query}`);
    list.innerHTML = data.posts.length
      ? data.posts.map(storyCard).join("")
      : `<p class="empty-state">${state.search || state.tag ? "No stories match those filters yet." : "The page is still blank. Be the first to share a story."}</p>`;
  } catch (error) {
    list.innerHTML = `<p class="empty-state">${escapeHtml(error.message)}</p>`;
  }

  const tagFilter = document.querySelector("#tag-filter");
  try {
    const { tags } = await api("/api/tags");
    tagFilter.innerHTML = `<option value="">All topics</option>${tags.map((tag) => `<option value="${escapeHtml(tag)}">${escapeHtml(tag)}</option>`).join("")}`;
    tagFilter.value = state.tag;
  } catch (error) {
    showToast(error.message);
  }

  function applyHomeFilters() {
    const query = new URLSearchParams();
    if (state.search) query.set("search", state.search);
    if (state.tag) query.set("tag", state.tag);
    const suffix = query.toString() ? `?${query}` : "";
    history.replaceState(null, "", `/${suffix}#stories`);
    const params = new URLSearchParams();
    if (state.search) params.set("search", state.search);
    if (state.tag) params.set("tag", state.tag);
    api(`/api/posts?${params}`).then(({ posts }) => {
      list.innerHTML = posts.length
        ? posts.map(storyCard).join("")
        : `<p class="empty-state">${state.search || state.tag ? "No stories match those filters yet." : "The page is still blank. Be the first to share a story."}</p>`;
    }).catch((error) => {
      list.innerHTML = `<p class="empty-state">${escapeHtml(error.message)}</p>`;
    });
  }

  const searchInput = document.querySelector("#search-input");
  searchInput.addEventListener("input", () => {
    state.search = searchInput.value.trim();
    clearTimeout(searchInput.timeout);
    searchInput.timeout = setTimeout(applyHomeFilters, 250);
  });
  tagFilter.addEventListener("change", () => {
    state.tag = tagFilter.value;
    applyHomeFilters();
  });
}

function authPage(mode, error = "") {
  const registering = mode === "register";
  const next = new URLSearchParams(location.search).get("next") || "/";
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/";
  app.innerHTML = `
    <section class="page-shell auth-page">
      <p class="eyebrow">YOUR SPACE TO WRITE</p>
      <h1>${registering ? "Join the conversation." : "Welcome back."}</h1>
      <p class="page-intro">${registering ? "Create an account to publish stories and join the conversation." : "Sign in to pick up where you left off."}</p>
      <form id="auth-form" data-mode="${mode}" data-next="${escapeHtml(safeNext)}">
        ${registering ? '<label class="form-field">Your name<input name="name" maxlength="60" autocomplete="name" required></label>' : ""}
        <label class="form-field">Email address<input name="email" type="email" maxlength="254" autocomplete="email" required></label>
        <label class="form-field">Password<input name="password" type="password" minlength="8" maxlength="128" autocomplete="${registering ? "new-password" : "current-password"}" required></label>
        <p class="form-error" id="auth-error" role="alert">${escapeHtml(error)}</p>
        <button class="button button-dark button-wide" type="submit">${registering ? "Create account" : "Sign in"}</button>
      </form>
      <p class="auth-switch">${registering ? "Already have an account?" : "New to Inkwell?"} <a href="/${registering ? "login" : "register"}${safeNext !== "/" ? `?next=${encodeURIComponent(safeNext)}` : ""}">${registering ? "Sign in" : "Create an account"}</a></p>
    </section>`;
}

async function renderEditor(postId = null) {
  if (!state.user) {
    location.replace(`/login?next=${encodeURIComponent(location.pathname)}`);
    return;
  }

  let post = null;
  if (postId) {
    try {
      const result = await api(`/api/posts/${postId}`);
      post = result.post;
      if (post.author_id !== state.user.id) {
        app.innerHTML = `<section class="page-shell"><h1>That story belongs to someone else.</h1><a class="text-link" href="/">Back to stories</a></section>`;
        return;
      }
    } catch (error) {
      app.innerHTML = `<section class="page-shell"><h1>We couldn't open that story.</h1><p class="page-intro">${escapeHtml(error.message)}</p><a class="text-link" href="/">Back to stories</a></section>`;
      return;
    }
  }

  app.innerHTML = `
    <section class="page-shell editor-page">
      <p class="eyebrow">MAKE SOMETHING OF IT</p>
      <h1>${post ? "Give it another pass." : "Put it into words."}</h1>
      <p class="page-intro">${post ? "Update your story and save your changes." : "A good story can start anywhere. Write yours here."}</p>
      <form id="post-form" data-post-id="${post ? post.id : ""}">
        <label class="form-field">Title<input name="title" maxlength="140" placeholder="A title that draws you in" value="${post ? escapeHtml(post.title) : ""}" required></label>
        <label class="form-field">Tags <span class="field-hint">Comma-separated, up to 8 tags</span><input name="tags" maxlength="220" placeholder="writing, ideas, travel" value="${post ? escapeHtml(post.tags) : ""}"></label>
        <label class="form-field">Your story<textarea name="body" rows="14" maxlength="20000" placeholder="Start wherever you are...">${post ? escapeHtml(post.body) : ""}</textarea></label>
        <label class="form-field">Publishing status<select name="status"><option value="published" ${!post || post.status === "published" ? "selected" : ""}>Publish now</option><option value="draft" ${post && post.status === "draft" ? "selected" : ""}>Save as draft</option></select></label>
        <p class="form-error" id="post-error" role="alert"></p>
        <div class="form-actions"><a class="button button-quiet" href="${post ? `/posts/${post.id}` : "/"}">Cancel</a><button class="button button-dark" id="post-submit" type="submit"></button></div>
      </form>
    </section>`;
  const statusSelect = document.querySelector("#post-form").elements.status;
  const bodyField = document.querySelector("#post-form").elements.body;
  const submit = document.querySelector("#post-submit");
  const updatePublishControls = () => {
    const isDraft = statusSelect.value === "draft";
    bodyField.required = !isDraft;
    submit.textContent = isDraft ? "Save as draft" : (post ? "Save changes" : "Publish story");
  };
  statusSelect.addEventListener("change", updatePublishControls);
  updatePublishControls();
}

function commentsMarkup(post) {
  if (!post.comments.length) return '<p class="empty-state">No comments yet. Start the conversation.</p>';
  return post.comments.map((comment) => `
    <div class="comment">
      <div class="comment-body"><strong>${escapeHtml(comment.author)}</strong><time>${formatDate(comment.created_at)}</time><p>${escapeHtml(comment.body)}</p></div>
      ${state.user && (state.user.id === comment.author_id || state.user.id === post.author_id) ? `<button class="mini-button" type="button" data-delete-comment="${comment.id}">Remove</button>` : ""}
    </div>`).join("");
}

async function renderStory(postId) {
  try {
    const { post } = await api(`/api/posts/${postId}`);
    const owner = state.user && state.user.id === post.author_id;
    app.innerHTML = `
      <section class="page-shell story-page">
        <a class="back-link" href="/">← All stories</a>
        <article>
          <div class="story-meta detail-meta"><span class="avatar">${escapeHtml(post.author.slice(0, 1))}</span><a href="/profile/${post.author_id}">${escapeHtml(post.author)}</a><span class="meta-dot">·</span><time>${formatDate(post.created_at)}</time>${post.status === "draft" ? '<span class="status-pill">Draft</span>' : ""}</div>
          <h1 class="detail-title">${escapeHtml(post.title)}</h1>
          ${post.tags ? `<div class="tag-list">${post.tags.split(",").map((tag) => `<a class="tag-chip" href="/?tag=${encodeURIComponent(tag.trim())}">${escapeHtml(tag.trim())}</a>`).join("")}</div>` : ""}
          <div class="detail-body">${escapeHtml(post.body)}</div>
          ${post.status === "published" ? `<div class="detail-actions social-actions"><button class="button button-quiet" type="button" data-like-post="${post.id}" aria-pressed="${post.liked}">${post.liked ? "♥ Liked" : "♡ Like"} · ${post.like_count}</button><button class="button button-quiet" type="button" data-bookmark-post="${post.id}" aria-pressed="${post.bookmarked}">${post.bookmarked ? "Saved to bookmarks" : "Bookmark"}</button></div>` : ""}
          ${owner ? `<div class="detail-actions"><a class="button button-quiet" href="/posts/${post.id}/edit">Edit story</a><button class="button button-quiet" type="button" data-delete-post="${post.id}">Delete story</button></div>` : ""}
        </article>
        <section class="comments"><h2>Conversation <span class="heading-period">(${post.comments.length})</span></h2>
          <div id="comment-list">${commentsMarkup(post)}</div>
          ${post.status === "draft" ? '<p class="page-intro">Draft stories are private. Publish this story to open comments.</p>' : state.user
            ? `<form class="comment-form" id="comment-form" data-post-id="${post.id}"><label class="sr-only" for="comment-input">Write a comment</label><textarea id="comment-input" name="body" maxlength="2000" placeholder="Add a thoughtful comment…" required></textarea><button class="button button-dark" type="submit">Post</button></form>`
            : `<p class="page-intro">Want to join the conversation? <a href="/login?next=${encodeURIComponent(`/posts/${post.id}`)}">Sign in</a> or <a href="/register?next=${encodeURIComponent(`/posts/${post.id}`)}">create an account</a>.</p>`}
        </section>
      </section>`;
  } catch (error) {
    app.innerHTML = `<section class="page-shell"><h1>Story not found.</h1><p class="page-intro">${escapeHtml(error.message)}</p><a class="text-link" href="/">Back to stories</a></section>`;
  }
}

async function renderCollection(title, endpoint, description, activePath) {
  try {
    const { posts } = await api(endpoint);
    app.innerHTML = `
      <section class="page-shell collection-page">
        <p class="eyebrow">YOUR INKWELL</p>
        <h1>${escapeHtml(title)}</h1>
        <p class="page-intro">${escapeHtml(description)}</p>
        ${activePath === "/me" ? `<nav class="collection-tabs"><a class="${location.search.includes("draft") ? "" : "active"}" href="/me">Published</a><a class="${location.search.includes("draft") ? "active" : ""}" href="/me?status=draft">Drafts</a></nav>` : ""}
        <div class="story-list collection-list">${posts.length ? posts.map(storyCard).join("") : `<p class="empty-state">${activePath === "/bookmarks" ? "Stories you bookmark will appear here." : location.search.includes("draft") ? "Your drafts will appear here." : "Your published stories will appear here."}</p>`}</div>
      </section>`;
  } catch (error) {
    app.innerHTML = `<section class="page-shell"><h1>Sign in to continue.</h1><p class="page-intro">${escapeHtml(error.message)}</p><a class="button button-dark" href="/login?next=${encodeURIComponent(location.pathname + location.search)}">Sign in</a></section>`;
  }
}

async function renderProfile(userId) {
  try {
    const { user, posts } = await api(`/api/users/${userId}`);
    app.innerHTML = `
      <section class="page-shell profile-page">
        <p class="eyebrow">MEET THE WRITER</p>
        <div class="profile-heading"><span class="profile-avatar">${escapeHtml(user.name.slice(0, 1))}</span><div><h1>${escapeHtml(user.name)}</h1><p class="page-intro">${user.bio ? escapeHtml(user.bio) : "A member of the Inkwell community."}</p><span class="profile-date">Writing here since ${formatDate(user.created_at)}</span></div></div>
        <h2 class="collection-heading">Stories by ${escapeHtml(user.name)}<span class="heading-period">.</span></h2>
        <div class="story-list collection-list">${posts.length ? posts.map(storyCard).join("") : '<p class="empty-state">This writer has not published any stories yet.</p>'}</div>
      </section>`;
  } catch (error) {
    app.innerHTML = `<section class="page-shell"><h1>Writer not found.</h1><p class="page-intro">${escapeHtml(error.message)}</p><a class="text-link" href="/">Back to stories</a></section>`;
  }
}

function renderProfileSettings() {
  if (!state.user) {
    location.replace(`/login?next=${encodeURIComponent("/settings")}`);
    return;
  }
  app.innerHTML = `
    <section class="page-shell auth-page">
      <p class="eyebrow">YOUR INKWELL</p>
      <h1>Edit your profile.</h1>
      <p class="page-intro">Update how readers see you on Inkwell.</p>
      <form id="profile-form">
        <label class="form-field">Your name<input name="name" maxlength="60" value="${escapeHtml(state.user.name)}" required></label>
        <label class="form-field">Short bio <span class="field-hint">Up to 280 characters</span><textarea name="bio" maxlength="280" rows="5" placeholder="A little about you...">${escapeHtml(state.user.bio || "")}</textarea></label>
        <p class="form-error" id="profile-error" role="alert"></p>
        <button class="button button-dark button-wide" type="submit">Save profile</button>
      </form>
      <p class="auth-switch"><a href="/profile/${state.user.id}">View your public profile</a></p>
    </section>`;
}

async function deletePost(postId) {
  if (!window.confirm("Delete this story and its comments? This cannot be undone.")) return;
  try {
    await api(`/api/posts/${postId}`, { method: "DELETE" });
    location.assign("/");
  } catch (error) {
    showToast(error.message);
  }
}

async function renderRoute() {
  const path = location.pathname.replace(/\/+$/, "") || "/";
  if (path === "/") return renderHome();
  if (path === "/login") return authPage("login");
  if (path === "/register") return authPage("register");
  if (path === "/write") return renderEditor();
  if (path === "/me") return renderCollection("My stories", `/api/me/posts?status=${new URLSearchParams(location.search).get("status") === "draft" ? "draft" : "published"}`, "Your published work and works in progress.", "/me");
  if (path === "/bookmarks") return renderCollection("Saved stories", "/api/me/bookmarks", "Stories you have saved for later.", "/bookmarks");
  if (path === "/settings") return renderProfileSettings();
  const profileMatch = path.match(/^\/profile\/(\d+)$/);
  if (profileMatch) return renderProfile(profileMatch[1]);
  const editMatch = path.match(/^\/posts\/(\d+)\/edit$/);
  if (editMatch) return renderEditor(editMatch[1]);
  const postMatch = path.match(/^\/posts\/(\d+)$/);
  if (postMatch) return renderStory(postMatch[1]);
  app.innerHTML = `<section class="page-shell"><h1>Page not found.</h1><a class="text-link" href="/">Back to stories</a></section>`;
}

elements.signOut.addEventListener("click", () => signOut());

document.addEventListener("submit", async (event) => {
  if (event.target.id === "auth-form") {
    event.preventDefault();
    const form = event.target;
    const errorElement = document.querySelector("#auth-error");
    const mode = form.dataset.mode;
    const payload = Object.fromEntries(new FormData(form).entries());
    try {
      const result = await api(`/api/auth/${mode === "register" ? "register" : "login"}`, {
        method: "POST", body: JSON.stringify(payload),
      });
      state.token = result.token;
      state.user = result.user;
      localStorage.setItem("inkwell-token", result.token);
      updateHeader();
      location.assign(form.dataset.next || "/");
    } catch (error) {
      errorElement.textContent = error.message;
    }
  }

  if (event.target.id === "post-form") {
    event.preventDefault();
    const form = event.target;
    const postId = form.dataset.postId;
    const payload = Object.fromEntries(new FormData(form).entries());
    if (payload.status === "published" && !payload.body.trim()) {
      document.querySelector("#post-error").textContent = "Add some story text before publishing.";
      return;
    }
    try {
      const result = await api(postId ? `/api/posts/${postId}` : "/api/posts", {
        method: postId ? "PUT" : "POST", body: JSON.stringify(payload),
      });
      if (result.post.status === "draft") {
        location.assign("/me?status=draft");
      } else {
        location.assign(`/posts/${postId || result.post.id}`);
      }
    } catch (error) {
      document.querySelector("#post-error").textContent = error.message;
    }
  }

  if (event.target.id === "profile-form") {
    event.preventDefault();
    const form = event.target;
    try {
      const { user } = await api("/api/auth/me", {
        method: "PUT", body: JSON.stringify(Object.fromEntries(new FormData(form).entries())),
      });
      state.user = user;
      updateHeader();
      location.assign(`/profile/${user.id}`);
    } catch (error) {
      document.querySelector("#profile-error").textContent = error.message;
    }
  }

  if (event.target.id === "comment-form") {
    event.preventDefault();
    const form = event.target;
    const postId = form.dataset.postId;
    const submit = form.querySelector("button[type=submit]");
    submit.disabled = true;
    try {
      const body = new FormData(form).get("body");
      await api(`/api/posts/${postId}/comments`, {
        method: "POST", body: JSON.stringify({ body }),
      });
      await renderStory(postId);
      showToast("Your comment has been added.");
    } catch (error) {
      showToast(error.message);
      submit.disabled = false;
    }
  }
});

document.addEventListener("click", async (event) => {
  const deletePostButton = event.target.closest("[data-delete-post]");
  const deleteCommentButton = event.target.closest("[data-delete-comment]");
  const likeButton = event.target.closest("[data-like-post]");
  const bookmarkButton = event.target.closest("[data-bookmark-post]");
  if (likeButton || bookmarkButton) {
    const button = likeButton || bookmarkButton;
    const postId = button.dataset.likePost || button.dataset.bookmarkPost;
    const isLike = Boolean(likeButton);
    const currentlyActive = button.getAttribute("aria-pressed") === "true";
    try {
      await api(`/api/posts/${postId}/${isLike ? "like" : "bookmark"}`, {
        method: currentlyActive ? "DELETE" : "PUT",
      });
      await renderRoute();
      if (!isLike) showToast(currentlyActive ? "Removed from bookmarks." : "Story saved to bookmarks.");
    } catch (error) {
      if (!state.user) {
        location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
      } else {
        showToast(error.message);
      }
    }
  } else if (deletePostButton) {
    deletePost(deletePostButton.dataset.deletePost);
  } else if (deleteCommentButton) {
    try {
      await api(`/api/comments/${deleteCommentButton.dataset.deleteComment}`, { method: "DELETE" });
      const postId = location.pathname.match(/^\/posts\/(\d+)/)?.[1];
      if (postId) {
        await renderStory(postId);
        showToast("Comment removed.");
      }
    } catch (error) {
      showToast(error.message);
    }
  }
});

async function initialize() {
  document.querySelector("#footer-year").textContent = `© ${new Date().getFullYear()} Inkwell`;
  if (state.token) {
    try {
      const { user } = await api("/api/auth/me");
      state.user = user;
    } catch {
      localStorage.removeItem("inkwell-token");
      state.token = null;
    }
  }
  updateHeader();
  await renderRoute();
}

initialize();
