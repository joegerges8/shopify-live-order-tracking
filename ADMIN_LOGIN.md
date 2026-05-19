# Admin Login — Implementation Guide

## What Was Built

A login system that protects the dispatcher dashboard so only the admin can access it. Before this change, anyone who knew the URL could view orders, manage drivers, and change statuses. Now every page and every API endpoint requires a valid admin session.

---

## How It Works (Login Flow)

1. User visits `/dashboard/index.html` or `/dashboard/drivers.html`
2. A script runs immediately and checks `localStorage` for a valid admin token
3. If no token (or expired) → redirected to `/dashboard/login.html`
4. User enters username + password on the login page
5. Browser sends `POST /api/admin/login` to the server
6. Server checks username against `ADMIN_USERNAME` env var and password against `ADMIN_PASSWORD` env var (bcrypt hash)
7. If correct → server returns a JWT token (valid for 8 hours)
8. Token is saved in `localStorage`, user is redirected to the dashboard
9. Every API call (orders, drivers) now sends `Authorization: Bearer <token>` in the header
10. Server middleware verifies the token before allowing any data through
11. Logout button clears the token and redirects back to the login page

---

## Files Created

### `src/middleware/requireAdminAuth.js`
Runs before any protected API route. Reads the `Authorization: Bearer <token>` header, verifies the JWT using `JWT_SECRET`, and checks that `token.type === "admin"`. Returns `401 Unauthorized` if anything is wrong.

### `src/controllers/adminAuthController.js`
Handles the login request. Reads `ADMIN_USERNAME` and `ADMIN_PASSWORD` from environment variables, compares the submitted password against the stored bcrypt hash, and returns a signed JWT on success.

### `src/routes/adminRoutes.js`
Defines the single public route: `POST /api/admin/login`.

### `dispatcher-dashboard-frontend/login.html`
The login page. Styled to match the dashboard. On submit it calls `/api/admin/login`, stores the returned token in `localStorage`, and redirects to `index.html`. If a valid token already exists, it skips the login page automatically.

### `dispatcher-dashboard-frontend/js/auth.js`
A shared script loaded on every dashboard page. Provides two functions:
- `requireAuth()` — checks if a valid non-expired token exists; redirects to login if not
- `logout()` — clears the token and redirects to login

---

## Files Modified

### `src/app.js`
- Imports `adminRoutes` and `requireAdminAuth`
- Mounts `POST /api/admin/login` at `/api/admin`
- Wraps all `/api/orders` routes with `requireAdminAuth`

### `src/routes/driverRoutes.js`
Added `requireAdminAuth` to the three dispatcher-facing routes:
- `GET /api/drivers` — list all drivers
- `POST /api/drivers` — create a driver
- `DELETE /api/drivers/:id` — delete a driver

The driver self-service routes (`/login`, `/signup`, `/me/*`) are **not** affected — drivers can still use their app normally.

### `dispatcher-dashboard-frontend/js/api.js`
Added an `authHeaders()` helper that reads the token from `localStorage` and attaches it as an `Authorization: Bearer` header to every fetch call.

### `dispatcher-dashboard-frontend/index.html` and `drivers.html`
- Added `auth.js` script and `requireAuth()` call in `<head>` — redirects to login before the page loads if unauthenticated
- Added a red **Logout** button at the bottom of the sidebar

### `dispatcher-dashboard-frontend/css/style.css`
- Added `display: flex; flex-direction: column` to `.sidebar` so the logout button sits at the bottom
- Added `.btn-logout` style (red button, matches existing design)

---

## Environment Variables

Two variables must be set — in `.env` for local development and in Railway for production:

| Variable | Description |
|---|---|
| `ADMIN_USERNAME` | The login username (e.g. `admin`) |
| `ADMIN_PASSWORD` | A **bcrypt hash** of your password (NOT the plain password) |

### Changing Your Password

1. Run this command with your new password:
   ```bash
   node -e "require('bcryptjs').hash('YourNewPassword', 10).then(console.log)"
   ```
2. Copy the output (starts with `$2b$10$...`)
3. Paste it as the value of `ADMIN_PASSWORD` in `.env` and in Railway Variables

---

## Security Notes

- The plain-text password is **never stored anywhere** — only the bcrypt hash
- The JWT token expires after **8 hours** — the user must log in again after that
- Driver app routes are completely unaffected by this change
- The customer tracking page (`/track/`) is also unaffected — it remains public
