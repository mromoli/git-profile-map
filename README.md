# Git Profile Map

A local desktop app for seeing which Git commit identity and remote login method a repository uses. It also shows the resolved SSH host and candidate identity files, and lets you switch a repository's local commit identity and SSH host alias through a review screen.

Use **New SSH profile** to create a separate Ed25519 key and named SSH host for a GitHub, GitLab, or Bitbucket account. The app shows the public key and opens the account's SSH key settings page, where you add it. The private key stays in `~/.ssh` and is never uploaded by the app. After adding the public key, select the new host under **Switch this repository**. This also converts an HTTPS origin to SSH after you review and confirm the change. Creating a profile does not change any repository on its own.

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
- Named `Host` aliases in `~/.ssh/config` for the switch menu.

The app never opens private key files. Inspecting a repository only reads local configuration; watchlist checks contact the configured remote. `ssh -G` reports configuration, not proof that a particular key will authenticate; an SSH agent or command override can affect the key used at connection time. HTTPS credential helpers are named but their stored credentials are not read.

## What a switch writes

After a preview and confirmation, the app writes `user.name` and `user.email` to that repository's local Git config. If an SSH host is selected, it changes only `origin` to use that host alias. The SSH config and global Git config are never modified. A failed switch attempts to restore the previous local values and origin URL.

Run `npm test` to test URL classification and the inspect/switch flow in a temporary repository.
