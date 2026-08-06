# Contributing to Omnibus

First off, thank you. Omnibus is better because people take the time to report problems and propose improvements. This guide explains how to do that so your work gets reviewed and merged with the least friction for everyone.

> ### The golden rule: open an issue *before* you write code.
>
> Omnibus is a young project with a small team (me). Talking first before you build lets us avoid two people building the same thing, spares you from spending a weekend on something that doesn't fit the project's direction, and lets us agree on the approach up front. A pull request that arrives out of nowhere is much harder to accept than one we discussed beforehand.

## Reporting a bug or requesting a feature

Everything starts with an issue.

**Before you open one,** take a quick look through the [existing issues](https://github.com/hankscafe/omnibus/issues) and [open pull requests](https://github.com/hankscafe/omnibus/pulls) to see whether someone has already reported it or is already working on it. If so, add your details to that thread instead of opening a duplicate it keeps the discussion in one place and stops two people solving the same problem twice.

**When you open a new issue, please include:**

- **A clear, detailed description** of the bug or the feature. For a bug: what you expected to happen, what actually happened, and the exact steps to reproduce it. For a feature: what problem it solves and how you imagine it working.
- **Screenshots or a short screen recording.** For anything visual a UI bug, a layout problem, a screen you're proposing a picture saves a lot of back-and-forth. For a bug, a screenshot of the error or the relevant **System Logs** entry is gold.
- **Your setup:** the Omnibus version (shown in the app), how you're running it (Docker standard or Postgres profile), and your OS/browser if it's relevant.

**[Open a new issue](https://github.com/hankscafe/omnibus/issues/new)**

## Agreeing on the approach

For a small, obvious fix (a typo, a broken link, a one-line bug), the issue itself is usually enough.

For anything larger like a new feature, a refactor, a change to how something works I'm going to want to talk about the *how* before you build it. Put your proposed approach in the issue, or start a thread in [GitHub Discussions](https://github.com/hankscafe/omnibus/discussions) for bigger design questions, and wait for a maintainer to give it a thumbs-up before you invest real time. This is the single best way to make sure your effort ends in a merged PR rather than a declined one.

If you'd rather ask a quick question, share a status update, or just talk through an idea, the **[Omnibus Discord](https://discord.gg/YDf9bqRgpQ)** is the fastest way to reach us.

## Submitting a pull request

Once your issue has been discussed and given the go-ahead:

1. **Fork the repo** and create a branch off **`dev`** (not `main` see below).
2. **Make your change.** Keep the PR focused on the one issue it addresses; several unrelated changes in one PR are much harder to review than one clear change. Try to match the style of the surrounding code.
3. **Run the checks** (the same suites and builds CI runs see [Development](#development) below). A green PR is a fast PR.
4. **Open the pull request against `dev`,** and reference the issue it resolves (e.g. "Closes #123"). Include before/after screenshots for any UI change.

### Target the `dev` branch

Omnibus uses two long-lived branches:

- **`main`** is the stable release channel it's what most people run. It only receives changes that have soaked on `dev` first.
- **`dev`** is where all new work lands and soaks before a release.

**All pull requests should target `dev`.** GitHub may default the base to `main` when you open a PR please switch it to `dev` using the base-branch dropdown near the top of the PR form. If you forget, no worries: I'll just ask you to retarget it.

### Please don't bump the version

Leave the `version` in `package.json` alone. Version numbers and releases are handled by the maintainers when `dev` is merged into `main`; a version change inside a PR only creates a merge conflict.

## Development

Omnibus is two applications that share one database: a **Next.js web app** (Node) and a **Rust engine** (`omnibus-engine/`) that does the heavy lifting scanning, conversion, downloads, metadata, and search. Depending on what you're changing, you may only need to touch one of them.

**Prerequisites:** Node 22; and for engine work, Rust 1.96 plus the C build deps (`build-essential clang libclang-dev pkg-config`) and the `unrar` / `unar` CLIs at runtime. The easiest way to run the full stack locally is the Docker Compose setup in the [README](README.md).

**Web app (Node):**

```bash
npm ci --legacy-peer-deps   # install
npm run dev                 # run locally
npm run lint                # eslint
npx tsc --noEmit            # type-check
npm test                    # vitest
npm run build               # production build (CI runs this)
```

**Engine (Rust), from `omnibus-engine/`:**

```bash
cargo build
cargo clippy --all-targets -- -D warnings   # CI treats warnings as errors
cargo test
```

Please make sure the relevant checks pass before opening your PR. If you add new behavior, a test that covers it is very welcome.

### Required CI checks

Two status checks run automatically on every pull request, and **both must pass before it can be merged** (this is enforced on the `main` and `dev` branches, so the Merge button stays locked until they're green):

- **`build-and-test`** runs the Node app's Vitest suite and the Next.js production build.
- **`Rust Engine (build · clippy · test)`** runs the engine's `cargo build`, Clippy (warnings are treated as errors), and `cargo test`.

Running the commands above locally before you push is the fastest way to a green PR. One note for your first contribution: GitHub holds the CI run until I approve it, so expect a short wait before the checks start on your very first PR.

## How pull requests are reviewed

Every PR is read and considered on its merits: does it fix a real problem, does it fit the direction of the project, and does it keep the codebase healthy? A few honest expectations:

- **I may ask for changes.** Review comments are about the code, never about you please don't take them personally. A little back-and-forth is normal and makes the result better.
- **A PR may be merged in whole, in part, or not at all.** Sometimes I'll take the core of a change but leave a piece out; sometimes an idea is good but the timing or approach isn't right and I'll decline it. This is exactly why the issue-first conversation matters, it's where we sort most of that out *before* you've done the work.
- **A "no" isn't a judgment of you or your idea** it's about what the project can take on right now.

## Contact

- **[Discord](https://discord.gg/YDf9bqRgpQ)** — questions, status updates, quick chats, or just saying hi. The fastest way to reach the team.
- **[GitHub Issues](https://github.com/hankscafe/omnibus/issues)** — bug reports and feature requests.
- **[GitHub Discussions](https://github.com/hankscafe/omnibus/discussions)** — bigger design conversations and open-ended questions.

## License

Omnibus is licensed under the [GNU GPL v3.0](LICENSE). By contributing, you agree that your contributions will be licensed under the same license.
