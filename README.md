# Git Profile Map

A local desktop app for seeing which Git commit identity and sign-in method a repository uses, and for switching it between your accounts (for example personal and work) through a review screen.

## Profiles

A profile is one Git account on one host. There are two kinds:

- **SSH key.** Creates a separate Ed25519 key and a named `Host` alias in `~/.ssh/config` for a GitHub, GitLab or Bitbucket account. The app shows the public key and opens the account's SSH key page, where you add it. The private key stays in `~/.ssh`. The new block is placed before any `Host *` or `Match` block so a catch-all key cannot sign you in as the wrong account.
- **HTTPS login.** Saves a host and username. If you paste a personal access token, the app hands it to Git's own credential helper (macOS Keychain, Git Credential Manager, libsecret) with `git credential approve`; the app never stores tokens. Without a token, Git asks you to sign in the first time and the helper remembers it.

Creating a profile does not change any repository. Under **Switch this repository**, pick a profile for the repository's host. A switch can convert between SSH and HTTPS in either direction.

Save repositories to the watchlist for a quick status view. The app checks each saved origin when it opens and every five minutes while visible. A manual **Test push (dry run)** checks whether Git would accept a push without uploading commits. Results include a timestamp and distinguish authentication, host trust, and network failures. A successful read check does not guarantee push permission; a successful dry run cannot guarantee that server rules will accept the eventual real push.

## Run

Install Node.js 20 or later, Git, and OpenSSH. Then run:

```sh
npm install
npm start
```

Build an installer on each target operating system with `npm run dist`. The build uses Electron Builder and writes output to `dist/`. Cross-platform targets are configured for macOS, Windows, and Linux; build each target on that operating system unless its required cross-compilation toolchain is available.

## What it reads

- Effective `user.name`, `user.email`, origin URL, credential helper, and `core.sshCommand`, including Git's conditional includes.
- The source file and scope reported by Git for each effective setting.
- OpenSSH's resolved host, user, and identity file candidates from `ssh -G`.
- Named `Host` aliases in `~/.ssh/config` and the files it `Include`s, for the switch menu.
- The HTTPS account set with `credential.https://<host>.username`.

The app never opens private key files. Inspecting a repository only reads local configuration; watchlist checks contact the configured remote. `ssh -G` reports configuration, not proof that a particular key will authenticate; an SSH agent or command override can affect the key used at connection time. HTTPS credential helpers are named but their stored credentials are not read. A password or token embedded in a remote URL is hidden in the window and flagged with a warning.

## What a switch writes

After a preview and confirmation, the app writes `user.name` and `user.email` to that repository's local Git config. If a profile is selected, it also rewrites `origin` (and its push URL, if one is set) to use that SSH alias, or to a clean HTTPS URL plus a local `credential.https://<host>.username`. Switching never touches the SSH config or the global Git config. A failed switch restores every value it changed.

Run `npm test` to test URL classification, profile creation and the inspect/switch flow in temporary repositories. Tests disable the system and global Git config, so they never touch your real credentials.

## Releases

Pushing a tag that matches the `version` in `package.json` builds installers for macOS, Windows and Linux on GitHub Actions and attaches them to a **draft** GitHub Release, which you review and publish by hand:

```sh
npm version minor   # bumps package.json and creates the v0.x.0 tag
git push --follow-tags
```

The macOS build is not code-signed or notarized, so the first launch needs right-click → Open (or `xattr -dr com.apple.quarantine "/Applications/Git Profile Map.app"`).
