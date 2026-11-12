# Running a demo instance

> **Open a public demo for strangers only with 0.22.1 or later, and only with its data on a filesystem of its own
> (step 0).** 0.22.0 left problems open for a demo that shares the disk and memory of one machine with other
> services (LIMITS-37 to LIMITS-42); 0.22.1 fixes them. What is still known is in [KNOWN-ISSUES.md, "Added in
> 0.22.1"](KNOWN-ISSUES.md#added-in-0221). A demo already started with 0.22.0 has to be moved first ("Moving a demo
> from 0.22.0" below).

A demo instance is a second Inkling server that strangers can sign up to and try. It runs next to your own
server but shares nothing with it: its own compose project, database, volumes, network and port. The
restricted mode of 0.22 turns on what such a server needs: sign-in IDs instead of email addresses, an
account cap, per-IP and hourly sign-up limits, accounts deleted 14 days after sign-up, limits on workspaces, members,
pages and storage, a storage fuse for the whole server, server-wide switches for features that send data outside, terms and consent at sign-up,
and a "Demo" label on every screen. Its data lives on a filesystem of its own, with its own size and inode limits, so it cannot fill
the disk your main instance uses (step 0). 한국어: [DEMO.ko.md](DEMO.ko.md).

The files are in [`deploy/demo/`](../deploy/demo/): `demo.sh` (the only way to start, stop and check the
demo), `compose.demo.yaml` (an overlay on `compose.yaml`), `demo.env.example` (the settings) and `legal/`
(templates of the terms, privacy policy and sign-up texts). Design notes: ADR 2500–2551.

## 0. A filesystem for the demo's data

Make this on the server before the first `up`. The demo's database, uploads, backups and backup control files
go in four folders (`db`, `data`, `backups`, `backup-ctl`) under one path, `DEMO_VOLUME_ROOT`. Mount a
filesystem made only for the demo there. The storage fuse (`LIMIT_INSTANCE_STORAGE_MB`) does not see the WAL,
the backups or the logs, and it trips only after the fact. A filesystem with its own size is what keeps a demo
user from filling the disk your main instance uses. `demo.sh up` refuses a `DEMO_VOLUME_ROOT` on the root
filesystem (or on the filesystem of Docker's data folder).

You do this yourself, as root on the server: this page and the scripts never create, mount or delete
filesystems. One way on Linux is an image file with ext4, mounted at every boot:

```bash
sudo fallocate -l 30G /var/lib/inkling-demo.img     # takes the 30 GB at once (not a sparse file)
sudo mkfs.ext4 -F -m 0 -N 600000 -L inkling-demo /var/lib/inkling-demo.img
sudo mkdir -p /srv/inkling-demo-data
sudo chattr +i /srv/inkling-demo-data               # the empty mount point: nothing can be created in it while unmounted
echo '/var/lib/inkling-demo.img /srv/inkling-demo-data ext4 loop,nodev,nosuid,noexec,nofail 0 2' | sudo tee -a /etc/fstab
sudo mount /srv/inkling-demo-data
sudo mkdir -p /srv/inkling-demo-data/db /srv/inkling-demo-data/data /srv/inkling-demo-data/backups /srv/inkling-demo-data/backup-ctl
findmnt /srv/inkling-demo-data && df -h /srv/inkling-demo-data && df -i /srv/inkling-demo-data
```

Then set `DEMO_VOLUME_ROOT=/srv/inkling-demo-data` in `demo.env`. A separate disk, partition, LVM volume or a
virtual machine works as well. After a reboot, check with `findmnt` that it is mounted before `demo.sh up`:
an empty mount point is on the root filesystem, so `up` refuses it rather than writing to the main disk.

**A reboot does not wait for `demo.sh`.** Docker starts the demo's containers again by itself
(`restart: unless-stopped` in `compose.yaml`), so the check of `up` does not run. If the filesystem failed to mount,
what keeps the demo off the root disk is only that the four folders are missing from the empty mount point: the
volumes are binds of those folders, so they should fail to mount and the containers should not start (not tried on
Linux, KNOWN-ISSUES LIMITS-51). Two things in the commands above are for this case: `nofail` lets the server finish booting when the image cannot
be mounted (without it a failed mount can stop the boot of the whole server), and `chattr +i` on the empty mount
point keeps anything, Docker included, from creating folders in it on the root disk (`chattr -i` before you ever
remove the mount point). So never create `db`, `data`, `backups` or `backup-ctl` while the filesystem is not
mounted, check `findmnt` after every reboot, and if you would rather start the demo yourself after a planned reboot,
run `deploy/demo/demo.sh down` before it (the data stays).

**Size**: fuse + 2 GB for the WAL + the number of backup sets × the fuse + headroom. With the preset
(`LIMIT_INSTANCE_STORAGE_MB=3000`, 7 daily backup sets) that is 3 + 2 + 7 × 3 = 26 GB, so 30 GB with
headroom. If you change the fuse or the backup sets, change the size to match. **Inodes**: with the preset, the
counted files are at most 100 workspaces × 10 MB / 5 KB (each file counts at least 5 KB), about 205,000, plus
the database's and the backups' files. `-N 600000` bounds the inodes and leaves room for them.

For a trial on a laptop without such a filesystem, `DEMO_ALLOW_SHARED_DISK=1 deploy/demo/demo.sh up` goes on with
a warning. Never do this for a public demo. On macOS a disk image works as a real one
(`hdiutil create -size 2g -fs APFS -volname demo demo.dmg`, then `hdiutil attach -mountpoint <folder> demo.dmg`).

## 1. Start it as a separate instance

Deploy the demo from a folder of its own: a second checkout of the same release, not the folder your main
instance runs from (that folder's `.env` and its usual commands belong to production). It can run on the
same machine:

```bash
git clone <the Inkling repository> /srv/inkling-demo/inkling    # a second copy, at the release you run
cd /srv/inkling-demo/inkling
cp deploy/demo/demo.env.example deploy/demo/demo.env
# fill in DEMO_POSTGRES_PASSWORD and DEMO_APP_SECRET_KEY (new values, see "Secrets" below),
# PUBLIC_URL: the public https address people will use (for example https://demo.example.com)
# and DEMO_VOLUME_ROOT: the filesystem of step 0
deploy/demo/demo.sh config     # check what would run; changes nothing
deploy/demo/demo.sh up         # builds the demo's own image (DEMO_IMAGE) the first time
```

Run every demo command through `deploy/demo/demo.sh` (`config`, `up`, `build`, `down`, `destroy`, `ps`, `logs`,
`exec`), never plain `docker compose`. The script always uses the project name `inkling-demo`, both compose
files and `deploy/demo/demo.env` (another file with `--env-file`), and passes nothing from your shell but
`PATH`, `HOME` and Docker's connection variables. It stops at once when `COMPOSE_PROJECT_NAME`,
`COMPOSE_FILE` or `INKLING_DATA_NAME` is set in the shell. Before `up`, `down` and `destroy` it reads the
resolved configuration and refuses, doing nothing, unless the project is `inkling-demo`, every volume and
the network are named `inkling-demo_…`, the database and its role are `inkling_demo` and no port is 3000
(production's default); `config` prints the same checks, and `up` also refuses secrets still marked
`CHANGE-ME`. The app image must be the demo's own name (`DEMO_IMAGE`, `inkling-demo:local` in the example; a name
without `demo`, or production's `ghcr.io/prove1352/inkling`, is refused), so building or pulling for the demo never
replaces the image your main instance's next `up` runs. Every volume must be a folder under `DEMO_VOLUME_ROOT`,
written as an absolute path; before `up` that folder must exist on a filesystem of its own (step 0), and `up` makes
the four folders in it. These names are written out in `compose.demo.yaml` itself, so no variable your main instance
uses can point the demo at production's data, and plain `docker compose` with the overlay stops with a
message. Every demo setting is required, so the production `.env` can never start a demo with no limits.
`down` keeps the demo's volumes; `destroy` deletes them after you type the project name ("Closing the demo"
below). The app listens on `127.0.0.1:3100` only (`DEMO_PORT`); nothing is public until step 3.

To update the demo to a new release: `git pull` (or check out the release) in the demo's folder, then
`deploy/demo/demo.sh build` and `deploy/demo/demo.sh up`. `up` alone keeps running the image it built before.

**Before you open it** (before the proxy of step 3), run `deploy/demo/demo.sh config` and `deploy/demo/demo.sh up` on
the server without `DEMO_ALLOW_SHARED_DISK`. Both have to pass with `ok` lines only, and `up` has to print
`ok      DEMO_VOLUME_ROOT is a filesystem of its own`. If `up` refuses `DEMO_VOLUME_ROOT`, fix step 0; do not go on
with the override.

### Secrets

Make new secrets for the demo; never copy the main instance's values. Sessions and tokens of one instance
do not work on the other only while these differ.

```bash
openssl rand -base64 32    # DEMO_POSTGRES_PASSWORD
openssl rand -base64 32    # DEMO_APP_SECRET_KEY
openssl rand -base64 32    # DEMO_BACKUP_PASSPHRASE, only if BACKUP_RCLONE_REMOTE is set
```

They have demo-only names, so a production value exported in your shell is never picked up.

Until the operator account exists (step 4), the server takes no sign-up at all except the one made with
the setup link: a server with sign-up limits, an account lifetime or sign-in IDs and no administrator
answers every other sign-up with `SETUP_REQUIRED`, and its sign-up screen only says that it is waiting for
its operator. So the first stranger can never become the administrator, whatever the order of the steps.

## 2. Fill in the terms folder

Do this before anyone signs up, the operator included: everyone agrees to the folder's version, and an
edit made later asks everyone to agree again.

`deploy/demo/legal/` is a template with four placeholders: `{{OPERATOR_NAME}}`, `{{CONTACT_EMAIL}}`,
`{{SERVICE_URL}}` and `{{EFFECTIVE_DATE}}`. Copy it out of the repository, fill it in, and point
`DEMO_LEGAL_DIR` in `demo.env` at the copy:

```bash
sudo mkdir -p /srv/inkling-demo && sudo cp -r deploy/demo/legal /srv/inkling-demo/legal
# edit the four placeholders in /srv/inkling-demo/legal/*.md, then in demo.env:
#   DEMO_LEGAL_DIR=/srv/inkling-demo/legal
deploy/demo/demo.sh up
```

The server reads the folder once at start. A malformed `signup.json` stops it with the file and the reason
in the log; a placeholder left in a document is a warning at every start. The folder's version is a hash of
its files, so any edit followed by a restart asks every account, yours included, to agree again on the next
request. A restart also closes the open editing connections, so nobody keeps working on the old terms.

What the folder holds:

| File | Use |
|---|---|
| `terms.ko.md`, `terms.en.md` | Terms of Service, shown at `/terms` |
| `privacy.ko.md`, `privacy.en.md` | Privacy Policy, shown at `/privacy` |
| `signup.json` | The notice at the top of the sign-up form and the tick boxes (`id`, `required`, `label`, optional `doc` and `details`) |

A document with only one language is shown in that language to everyone. Documents are Markdown; HTML in
them is shown as text, and links work only for `http`, `https` and `mailto`.

The templates describe what the app does with the settings of this page. If you change a setting, check
the sentences about it (deletion after 14 days, trash 7 days, limits, features turned off).

## 3. Proxy

Put HTTPS for the address in `PUBLIC_URL` in front of `127.0.0.1:3100`. With an https address the session
cookie is Secure. With Caddy on the host:

```
demo.example.com {
	encode gzip zstd
	reverse_proxy 127.0.0.1:3100
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "strict-origin-when-cross-origin"
	}
}
```

`TRUST_PROXY=loopback,uniquelocal` makes the server take the client address from `X-Forwarded-For` when the
request comes from the proxy, which the per-IP sign-up limit needs. If the proxy keeps an access log, that
log holds IP addresses too. The privacy policy template describes the app's own logs (three files of 10 MB,
the oldest dropped first): keep the proxy's log on a rule no longer than that, or write its rule into the
policy.

## 4. Create the operator account with the setup link

```bash
deploy/demo/demo.sh logs app | grep -A2 'No accounts yet'
```

Open the `/setup?code=…` link from the log. It is built from `PUBLIC_URL`, so it opens at the public address
through the proxy. The server refuses form posts from any origin other than `PUBLIC_URL`, so use that address
(not `localhost:3100` through a tunnel, unless `PUBLIC_URL` says so). The link works once, only while there
are no accounts; a restart before that prints a new one. The setup form shows the same consent boxes as the
sign-up form: the operator agrees to the terms too. Administrator accounts never expire. Once the account
exists, the sign-up form opens to everyone.

## 5. Check before you announce it

- The start log has a line for the limits that are on, one for the features that are off, one for
  `LEGAL_DIR` with its version, and no placeholder warning.
- `curl -s https://demo.example.com/api/auth/mode` shows `loginId`, `instanceLabel`, `legal`, `limits` (with
  `trashDays`) and `disabledFeatures`, and `setupPending` is `false`.
- In a private window: the sign-up form asks for an ID, shows the notice and six unticked boxes, and the
  button stays off until all are ticked. `/terms` and `/privacy` open without signing in.
- After signing up, the deletion date is shown, and the "Demo" label is visible on a phone and on a computer.
- `deploy/demo/demo.sh config` prints only `ok` lines, and `deploy/demo/demo.sh ps` shows no published
  database port and only `127.0.0.1:3100` for the app.
- `deploy/demo/demo.sh up` printed `ok      DEMO_VOLUME_ROOT is a filesystem of its own`, and `df -h` of that folder
  shows the size you chose in step 0.
- Admin › Backups shows 7 daily, 0 weekly and 0 monthly sets, and Admin › Status lists **Server storage limit**.
- From one network, a third sign-up in a day is refused (the proxy passes the real address).

## Settings

One line each; the full reference is in the operations docs.

| Variable | Demo value | Meaning |
|---|---|---|
| `LOGIN_ID_MODE` | `username` | Sign up with an ID and a nickname instead of an email address |
| `SIGNUP_REQUIRE_KEY` | `0` | Anyone can sign up without a key |
| `SIGNUP_MAX_USERS` | `50` | Most accounts on the server, administrators included |
| `SIGNUP_PER_IP_PER_DAY` | `2` | Sign-ups from one address in 24 hours |
| `ACCOUNT_LIFETIME_DAYS` | `14` | Accounts made from now on are deleted this many days after sign-up |
| `ACCOUNT_LIFETIME_DRY_RUN` | empty | `1` logs what would be deleted and deletes nothing |
| `LIMIT_WORKSPACES_PER_USER` | `2` | Workspaces one person owns, deleted ones still restorable included |
| `LIMIT_MEMBERS_PER_WORKSPACE` | `4` | Members of one workspace |
| `LIMIT_PAGES_PER_WORKSPACE` | `300` | Pages of one workspace, trash included |
| `LIMIT_FILE_MB` | `5` | Size of one uploaded file |
| `LIMIT_WORKSPACE_STORAGE_MB` | `10` | Files (each counted as at least 5 KB), page bodies, version history and search indexes of one workspace |
| `LIMIT_VERSIONS_PER_PAGE` | `10` | Version history kept per page |
| `LIMIT_TRASH_DAYS` | `7` | Trashed pages are deleted for good after at most this many days, whatever a workspace sets |
| `WORKSPACE_RESTORE_DAYS` | `7` | Days a deleted workspace can be restored |
| `AGENT_UPLOAD_MAX_MB`, `AGENT_UPLOAD_DAILY_MB` | `5`, `10` | Uploads by AI agents: per file, per account per day |
| `LIMIT_WORKSPACES_TOTAL` | `100` | Workspaces on the whole server, deleted ones still restorable included; at it sign-up and new workspaces are refused |
| `LIMIT_INSTANCE_STORAGE_MB` | `3000` | Storage fuse: database plus uploads, measured once a minute; at it the demo only reads and deletes ("Disk and the storage fuse" below) |
| `APP_MEM_LIMIT`, `NODE_OPTIONS` | `768m`, `--max-old-space-size=448` | The app container's memory and the server's heap inside it ("Memory" below) |
| `DISABLED_FEATURES` | see `demo.env.example` | Features turned off on the whole server |
| `LEGAL_DIR` | `/legal` | The terms folder inside the container (`DEMO_LEGAL_DIR` on the host) |
| `INSTANCE_LABEL` | `Demo` | The label every screen shows |
| `INSTANCE_NOTICE` | empty | A notice on the sign-in, sign-up and consent screens and above every app screen (plain text, at most 500 characters) |
| `BACKUP_KEEP_DAILY`, `BACKUP_KEEP_WEEKLY`, `BACKUP_KEEP_MONTHLY` | `7`, `0`, `0` | Backup sets kept |
| `SIGNUP_PER_HOUR` | `10` | Accounts the whole server makes in one hour (the setup link's account does not count) |
| `OAUTH_UNUSED_CLIENT_HOURS` | `24` | Self-registered OAuth clients that were never used are deleted this many hours after registering |
| `OAUTH_UNUSED_CLIENT_MAX` | `500` | Most never-used self-registered OAuth clients kept; a new one removes the oldest (never one younger than 15 minutes) |
| `DEMO_PORT` | `127.0.0.1:3100` | The demo's host port (not 3000) |
| `DEMO_IMAGE` | `inkling-demo:local` | The demo's own image name, never production's (step 1) |
| `DEMO_VOLUME_ROOT` | the filesystem of step 0 | Absolute path; the demo's four volumes are folders in it |
| `DEMO_ALLOW_SHARED_DISK` | not set | Set to `1` in the shell for one `up` only: goes on, with a warning, when `DEMO_VOLUME_ROOT` is on the root filesystem (a trial, never a public demo) |
| `DEMO_POSTGRES_PASSWORD`, `DEMO_APP_SECRET_KEY`, `DEMO_BACKUP_PASSPHRASE` | new values | The demo's own secrets ("Secrets" above) |

Mail, OIDC, semantic search and experimental features stay off by leaving their variables empty. MCP stays on.

## What the operator should know

### Accounts are really deleted

`ACCOUNT_LIFETIME_DAYS=14` deletes an account, its private pages and files, and the workspaces only it was
in, 14 days after sign-up, whether or not it was used. Backups keep them for up to 7 more days. Accounts
made before the setting was on, and administrators, are never deleted by it.

To see what it would do before it deletes anything, start with `ACCOUNT_LIFETIME_DRY_RUN=1`. The hourly
housekeeping then logs one line per account it would delete (the account id and how many workspaces would
go) and deletes nothing. Once the first accounts pass their date and the log lists exactly those, empty the
value and run `deploy/demo/demo.sh up` again.

### Disk and the storage fuse

`LIMIT_INSTANCE_STORAGE_MB=3000` stops writes when the database and the uploads (their disk blocks) reach 3,000 MB: the demo then
only reads, signs in, exports and deletes, and the app shows a strip saying so. It usually stays that way until you make
room by hand, since deleting rows does not shrink the database file; what to do is in
[OPERATIONS.md, "Instance storage fuse"](OPERATIONS.md#instance-storage-fuse). A few addresses writing at full
speed for a minute or two can trip it on purpose; only the demo stops.

The fuse does not see the WAL, the backups or the logs; the demo's filesystem (step 0) holds them all and is sized
for them. Measured for 0.22.1 with the production build: about 880 MB of WAL after 200 MB of database writes.

What one workspace can make the database grow by, measured for 0.22.1: a workspace's storage counts its files,
page bodies, version history and the rows of its search indexes, but not Postgres's index entries and the space
that rewriting leaves. Filled once with text, through the editor's live connection or through the API, a 10 MB
workspace grew the database by 9–19 MB with prose and up to 25.6 MB with random words written on purpose. 100
workspaces filled that way come to at most about 2.6 GB, under the 3,000 MB fuse; a few accounts deleting and
writing again and again can still trip the fuse on purpose. That stops only the demo, and the filesystem keeps it
off your main disk.

### Memory

The app runs with a 448 MB heap in a 768 MB container (`NODE_OPTIONS`, `APP_MEM_LIMIT`), the database in 384 MB
and the backups in 256 MB. None of the three can use swap (`memswap_limit` equal to `mem_limit` in
`compose.demo.yaml`; `demo.sh` refuses a configuration where they differ or a limit is missing), so a container that
runs out is stopped and restarted instead of moving into the host's swap. None of the three writes a core dump
(`ulimits: core: 0` in `compose.demo.yaml`, which `demo.sh` checks): when the host's
`/proc/sys/kernel/core_pattern` is a pipe (`|…`, as with systemd-coredump or apport), a crash in a container is handed
to the host's handler, memory and all. Check that file on the server before you open the demo.

Measured for 0.22.1 with the production build (on macOS): an open page holds about 20 times its stored size in
memory. Three accounts filling pages at the largest size (2.5 MB, a quarter of a workspace's 10 MB) in both of their
workspaces, with every page kept open, peaked at a 332 MB heap and 588 MB of memory with the 448 MB heap (the
storage limit refused the rest after one such page per workspace). Before the limit counted live edits with their
index, the same run filled more and peaked at a 434 MB heap and 734 MB, and ran out of memory with 320 MB and
384 MB heaps. If you raise the heap, raise `APP_MEM_LIMIT` with it: the server took 255–325 MB besides its heap.
Pages of many tiny map entries can still run a 448 MB heap out of memory (one account, two pages); the container
then restarts.

### Posting a notice

The demo sends no mail, and the terms template says that notices (changed terms, changes, outages, a data
breach) appear in the app and on the sign-in screen. That is `INSTANCE_NOTICE`: set it in `demo.env`
(double quotes, `\n` for a line break, at most 500 characters) and run `deploy/demo/demo.sh up` again;
empty it the same way. It is shown as plain text, without links, and nobody can close it. A restart closes open editing
connections; they reconnect at once.

### Closing the demo without notice

If you shut the demo down, the privacy policy template promises that the database, the files and the
backups are deleted without delay:

```bash
deploy/demo/demo.sh destroy    # asks you to type inkling-demo
```

`destroy` stops the demo after the same checks as `up`, removes its volumes and its image, and prints where the
files still are: the volumes are folders under `DEMO_VOLUME_ROOT`, and the script never deletes files on the host.
Delete the four folders yourself (as root, after checking the path), or unmount the filesystem of step 0 and delete
its image file. The main instance is not touched. Also delete
remote backup copies if `BACKUP_RCLONE_REMOTE` was set, the proxy's access log for the demo host, the
filled terms folder and `demo.env`. If the server stopped suddenly, do this as soon as you can reach it.

### Moving a demo from 0.22.0

A demo started with 0.22.0 keeps its volumes as named volumes on Docker's disk, runs production's image name, and
has the 0.22.0 preset (20 MB per workspace, a 320 MB heap in 512 MB). Nothing moves it by itself, and its data is
not carried over (docs/adr/2546-*):

1. Tell its users with `INSTANCE_NOTICE` when the demo will be reset, so they can export what they want to keep.
2. In the demo's 0.22.0 checkout, run `deploy/demo/demo.sh destroy` (it deletes the demo's containers, volumes and
   data; the main instance is not touched). Run it before updating the checkout: the 0.22.1 script expects the new
   settings.
3. Make the filesystem of step 0, update the checkout to 0.22.1, and fill `demo.env` again from the new
   `demo.env.example` (`DEMO_IMAGE`, `DEMO_VOLUME_ROOT`, `LIMIT_WORKSPACE_STORAGE_MB=10`, `APP_MEM_LIMIT=768m`,
   `NODE_OPTIONS=--max-old-space-size=448`), keeping new secrets.
4. Fill the terms folder again from the 0.22.1 templates (the storage sentence changed), then follow steps 1 to 5:
   the operator account is made again with the setup link.

### These files are not legal advice

The templates in `deploy/demo/legal/` and this page are a starting point written for one operator's demo,
not legal advice. Read them, adapt them to your situation and your country, and have them checked if you
are unsure. Sentences in the templates that describe what the app does were written for the settings
above; change a setting and you may need to change the text.
