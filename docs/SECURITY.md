# Security

This document describes how chunklab handles secrets — chiefly the Groq API
key — and the verification gate that keeps them out of version control.

> ## ⚠️ WARNING
>
> The **Groq API key lives ONLY in a gitignored `.env` file**. It is **never
> committed**, never echoed to the terminal, and never printed in logs. The
> repository is **private**. The only file tracked in git is
> `.env.example`, which contains **placeholders only**
> (`GROQ_API_KEY=your-groq-api-key-here`). If you ever see a real key in a
> diff, a commit, or this repository, **stop and rotate it immediately** (see
> [Key rotation](#key-rotation)).

---

## What is a secret here

| Secret | Where it lives | Committed? |
| --- | --- | --- |
| `GROQ_API_KEY` (real, `gsk_…`) | local `.env` only | **No** |
| Postgres / Redis credentials | local `.env` / compose env | **No** (dev defaults only) |
| Placeholders & non-secret config | `.env.example` (tracked) | Yes — placeholders only |

All settings are read through `app.core.config.Settings` (`get_settings()`).
Nothing reads a hard-coded key; everything flows from the environment, which in
development is populated from `.env`.

---

## The `.gitignore` rules that protect secrets

The very first block of `/.gitignore` exists solely to keep secrets untracked:

```gitignore
# ===== SECRETS — never commit =====
.env
.env.*
!.env.example
*.key
*.pem
secrets/
```

Reading these rules:

- `.env` — the real environment file is ignored.
- `.env.*` — any variant (`.env.local`, `.env.production`, …) is ignored.
- `!.env.example` — the **only** exception: the placeholder template is
  re-included so contributors know which variables to set.
- `*.key`, `*.pem` — private keys and certificates are ignored.
- `secrets/` — any directory used to stage secrets is ignored.

---

## Pre-commit verification gate

**Before any `git add` / `git commit`**, run these three checks. All three must
pass. Do not commit if any fails.

### 1. `.env` is actually ignored

```bash
git check-ignore -v .env
```

This **must print a match**, e.g.:

```
.gitignore:2:.env	.env
```

A match confirms git is ignoring `.env` because of the rule on line 2. **No
output means `.env` is NOT ignored — stop and fix `.gitignore` before doing
anything else.**

### 2. No `.env` file is tracked

```bash
git ls-files | grep '\.env'
```

This **must return nothing** except possibly `.env.example`. If it lists a real
`.env` (or any `.env.*`), that file is already tracked — untrack it
(`git rm --cached <file>`) and treat the key as compromised
([rotate it](#key-rotation)).

### 3. No key was ever committed to history

```bash
git log -p | grep gsk_
```

This **must return nothing**. Groq keys are prefixed `gsk_`; any hit means a key
landed in history. Rotate the key immediately and scrub history before pushing
(or, for a fresh repo, re-init).

> Tip: you can run all three in sequence and eyeball the output before every
> commit. They are cheap and catch the most common mistake — accidentally
> staging a real `.env`.

---

## How `.env` was created

The local `.env` was created by **copying an existing key from another local
project, without echoing it to the terminal**:

- The Groq key was copied from `/Users/visakh/GitHub/mindmate_proj/.env` into
  chunklab's local `.env` using a file-to-file copy / editor paste — **never**
  via `echo`, `cat`, or any command that would print the key to the terminal
  (and therefore into shell history).
- The key was **never committed**. Only `.env.example` (placeholders) is in git.

To set up your own environment:

```bash
cp .env.example .env
# then open .env in an editor and paste your real GROQ_API_KEY
```

Avoid `echo "GROQ_API_KEY=gsk_…" >> .env` — that writes the secret into your
shell history. Edit the file directly instead.

---

## Key rotation

If a key is leaked, exposed in a diff, pushed by mistake, or you simply suspect
compromise, **rotate it — do not try to "un-leak" it**:

1. Go to **<https://console.groq.com>** → API Keys.
2. **Revoke / delete** the exposed key.
3. **Create a new key.**
4. Update the local `.env` with the new key (file edit, no terminal echo).
5. Restart the affected services so they pick up the new value:
   ```bash
   docker compose up -d backend worker
   ```
6. If the old key ever touched git history, scrub it from history before any
   push (e.g. `git filter-repo` / BFG), then force-push — or, for a fresh
   repository, re-initialize history.

A revoked key cannot be used by anyone, so rotation is the definitive fix.
Removing the leaked text alone is **not** sufficient.

---

## GitHub protections

Even though the repo is private, enable GitHub's secret-scanning defenses as a
safety net:

- **Secret scanning** — Settings → Code security and analysis → enable
  *Secret scanning*. GitHub detects provider key patterns (including Groq
  `gsk_` keys) and alerts you if one is found in the repo.
- **Push protection** — enable *Push protection* in the same panel. This blocks
  pushes that contain detected secrets **before** they reach GitHub, stopping a
  leak at the source rather than alerting after the fact.

These complement the local pre-commit gate; they do not replace it.

---

## Production secret handling

The `.env` file pattern is for **local development only**.

> In production, **inject secrets via a secret store — never a file checked out
> next to the code.**

- Do not bake `GROQ_API_KEY` (or any credential) into images, `.env` files in
  the deployment, or build args.
- Source secrets at runtime from a dedicated secret manager — e.g. AWS Secrets
  Manager, GCP Secret Manager, HashiCorp Vault, Doppler, or your orchestrator's
  native secrets (Kubernetes Secrets, Docker Swarm secrets). Provide them to the
  process as environment variables, which `app.core.config.Settings` already
  reads.
- Scope credentials to least privilege, rotate them on a schedule, and keep an
  audit trail of access.

---

## Quick reference

| Action | Command |
| --- | --- |
| Confirm `.env` is ignored | `git check-ignore -v .env` (must match) |
| Confirm no `.env` is tracked | `git ls-files \| grep '\.env'` (must be empty) |
| Confirm no key in history | `git log -p \| grep gsk_` (must be empty) |
| Create local env | `cp .env.example .env` then edit |
| Rotate a leaked key | revoke + recreate at <https://console.groq.com> |
