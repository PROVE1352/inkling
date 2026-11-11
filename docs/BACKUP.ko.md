# 백업과 복원

Inkling은 `compose.yaml`에 `backup` 사이드카 서비스를 넣어 두었고, 이 서비스는 **기본으로 켜져 있습니다**. 하루에 한 번 데이터베이스를 덤프하고, 데이터 볼륨(업로드한 파일, 플러그인)을 묶어 보관하고, 결과를 검증합니다. 기록은 할아버지-아버지-아들(GFS) 방식으로 남기고, 일주일에 한 번 세트 하나를 시험 삼아 복원해 보며, 원하면 세트마다 rclone으로 외부에 사본을 둡니다. 관리자는 **관리자 › 백업**(`Admin › Backups`)에서 상태를 보고, 백업을 시작하거나 세트를 내려받을 수 있습니다. 복원은 일부러 **명령줄에서만** 할 수 있게 했습니다(`deploy/restore.sh`). English: [BACKUP.md](BACKUP.md).

설계에 관한 설명은 [ADR 0600–0607](adr/README.md#06xx-backups)에 있습니다.

<a id="quick-start"></a>
## 빠르게 시작하기

따로 할 일은 없습니다. `docker compose up -d`를 하면 사이드카가 함께 뜨고, 매일 03:00(컨테이너 시간대 `TZ` 기준)에 백업합니다. 잘 도는지 확인해 보세요. 로그에 "[backup] started: schedule=daily@03:00 next=..."가 보이면 됩니다. `./deploy/backup.sh`는 지금 바로 하나를 받습니다.

```bash
docker compose logs backup            # "[backup] started: schedule=daily@03:00 next=..."
./deploy/backup.sh                    # take one now
./deploy/backup.sh list
```

그다음 다른 누구도 대신해 줄 수 없는 두 가지를 하세요.

1. **이 컴퓨터 밖에 사본을 두세요**(아래 3-2-1 규칙). `BACKUP_RCLONE_REMOTE`를 설정하거나, `./deploy/backup.sh copy-out <set> /mnt/usb`로 꺼낸 사본을 정기적으로 다른 곳에 옮겨 두면 됩니다.
2. **남는 컴퓨터에서 복원을 연습해 보세요**([복원 연습](#restore-rehearsal) 참고).

<a id="settings"></a>
## 설정

설정은 모두 `.env`에 적는 환경 변수이고, `backup` 서비스가 읽습니다. 관리자 페이지에서는 읽기 전용으로 보여 주기만 합니다. 바꾸려면 `.env`를 고치고 `docker compose up -d backup`을 실행하세요.

| 변수 | 기본값 | 뜻 |
|---|---|---|
| `BACKUP_ENABLED` | `1` | `0`이면 사이드카가 아무 일도 하지 않습니다(예약 백업도 수동 백업도 없음). |
| `BACKUP_SCHEDULE` | `daily@03:00` | `daily@HH:MM`, `hourly@MM`, `every@<N>m`, `every@<N>h`, `off`(수동만) 중 하나. `TZ`를 따릅니다. |
| `BACKUP_KEEP_DAILY` | `7` | 최근 N일 동안 날마다 가장 새 세트를 하나씩 남깁니다. |
| `BACKUP_KEEP_WEEKLY` | `4` | 최근 N개 ISO 주마다 하나씩 남깁니다. |
| `BACKUP_KEEP_MONTHLY` | `6` | 최근 N개월 동안 달마다 하나씩 남깁니다. 가장 새 세트는 언제나 남깁니다. |
| `BACKUP_RESTORE_TEST_DAYS` | `7` | N일마다 가장 새 세트를 임시 데이터베이스에 시험 복원합니다(`0` = 끔). |
| `BACKUP_MIN_FREE_MB` | `256` | 여유 공간. 백업 볼륨에 DB 크기 + 데이터 크기 + 이 값만큼 빈 공간이 없으면 시작하자마자 실패합니다. 기한이 지난 세트는 이 확인 *전에* 정리하므로, 가득 찬 볼륨은 스스로 공간을 비웁니다. |
| `BACKUP_PASSPHRASE` | 비어 있음 | 모든 세트를 암호화합니다([암호화](#encryption) 참고). |
| `BACKUP_RCLONE_REMOTE` | 비어 있음 | 외부 사본을 둘 곳. 예: `b2:my-bucket/inkling`, `s3:bucket/inkling`, `:local:/mnt/usb/inkling`. rclone 오버레이가 필요합니다. |
| `BACKUP_RCLONE_CONFIG` | `./deploy/rclone.conf` | 호스트에 있는 rclone 설정 파일의 경로(오버레이에서만 씁니다). |
| `TZ` | `UTC` | 일정과 GFS의 일·주·월 구간을 정하는 시간대. |

마운트 위치를 바꿀 때만 앱 쪽에서 `BACKUP_DIR`(기본 `/backups`)와 `BACKUP_CTL_DIR`(기본 `/backup-ctl`)을 정합니다.

<a id="what-a-backup-set-contains"></a>
## 백업 세트에 들어 있는 것

세트는 백업 볼륨(`inkling_inkling-backups`, 일반적으로는 `<project>_<INKLING_DATA_NAME>-backups`)의 `sets/<id>/` 아래에 있습니다. `<id>`는 UTC 기준 시작 시각 `YYYYMMDD-HHMMSS`입니다.

| 파일 | 내용 |
|---|---|
| `db.dump` / `db.dump.enc` | 데이터베이스 전체의 `pg_dump -Fc` |
| `data.tar.gz` / `data.tar.gz.enc` | 앱 데이터 볼륨(`/data`: `uploads/`, `plugins/`, …)의 tar |
| `manifest.json` | 시각, 크기, sha256, 앱 버전, 가장 최근 마이그레이션, 테이블마다의 행 수 |
| `SHA256SUMS` | 두 본체 파일(덤프와 아카이브)의 체크섬(`sha256sum -c` 호환) |

세트는 `sets/.tmp-<id>/`에서 만들어지고, 모든 단계가 성공한 다음에야 이름을 바꿔 제자리에 놓입니다. 그래서 실패하거나 중간에 끊긴 실행이 반쪽짜리 세트를 남기지 않습니다(남은 찌꺼기는 다음 실행이 지웁니다).

**일관성.** 데이터베이스 덤프는 `REPEATABLE READ` 스냅샷 하나에서 뜹니다. 사이드카가 스냅샷을 내보내고, 그 안에서 모든 테이블의 행 수를 센 다음, 같은 스냅샷으로 `pg_dump --snapshot`을 돌립니다. 그래서 manifest의 행 수는 덤프에 든 내용과 정확히 같습니다. 파일 아카이브는 덤프 *바로 뒤에* 만듭니다(manifest에 두 시각과 `consistency.gapSeconds`가 남습니다). 그 사이에 새로 올라온 파일은 아카이브에 아무도 참조하지 않는 파일이 하나 더 들어가는 것뿐이라 문제가 없습니다. 반대로 그 사이에 영구 삭제된 파일(휴지통 비우기)은 덤프에는 행이 남아 있는데 아카이브에서는 빠집니다. 스냅샷 직전 몇 초 동안 친 내용은 협업 서버가 아직 DB에 쓰지 않았을 수 있습니다.

**매번 하는 검증.** 저장한 덤프에 `pg_restore --list`를 돌리고(암호화돼 있으면 풀어서 돌립니다), 아카이브 목록을 끝까지 읽고, 쓴 파일에 `sha256sum -c`를 돌립니다. 이 중 하나라도 실패하면 그 실행은 실패로 칩니다. `pg_restore --list`는 목차만 읽고 멈추기 때문에, 검사는 나머지 스트림을 끝까지 읽어 냅니다. 그래서 파이프 버퍼(~64 KiB)보다 큰 덤프가 SIGPIPE 때문에 읽을 수 없다고 잘못 보고되지 않고, 암호화된 `.enc` 파일도 끝까지 복호화되므로 잘리거나 깨진 파일을 잡아냅니다.

**복원 테스트(기본은 매주).** 가장 새 세트를 같은 Postgres 서버의 임시 데이터베이스(`inkling_restoretest`)에 복원합니다. 그다음 모든 테이블의 행 수를 manifest와 비교하고, 아카이브 항목 수도 비교한 뒤, 데이터베이스를 지웁니다. 그동안 데이터베이스 서버의 디스크에 DB 크기만큼의 공간이 더 필요하고, 잠깐 부하가 늘어납니다. 손으로 돌리려면 `./deploy/backup.sh restore-test`를 실행하세요.

**잠금.** 백업, 복원 테스트, 복원은 `/backups/.lock`에 배타적 `flock`을 잡습니다. 두 번째로 시작한 실행은 바로 끝납니다. 프로세스가 죽으면 커널이 잠금을 풀기 때문에 비정상 종료 뒤에 잠금이 남는 일은 없습니다.

**서버 쪽 타임아웃.** 사이드카가 실행하는 모든 `psql`, `pg_dump`, `pg_restore`는 `PGOPTIONS`로 `statement_timeout=0`, `lock_timeout=0`, `idle_in_transaction_session_timeout=0`을 정합니다. 앱은 자기 연결에 15초 `statement_timeout`을 쓰지만 백업, 복원 테스트, 복원은 그 영향을 받지 않습니다. 운영자가 역할이나 데이터베이스 수준에 건 타임아웃도 마찬가지입니다(클라이언트 옵션이 우선합니다).

**보관.** GFS 정책은 실행이 시작될 때 디스크 공간을 확인하기 전에 한 번, 실행이 성공한 뒤에 다시 한 번 적용합니다. 그래서 가득 찬 볼륨은 계속 실패하는 대신 다음 실행에서 스스로 공간을 비우고, 가장 새 정상 세트는 언제나 남습니다. 한 번만 정리를 건너뛰려면 `docker compose exec backup bash /scripts/backup-run.sh --no-prune`을 실행하세요(`deploy/restore.sh`가 복원 전에 받는 안전 백업도 이렇게 합니다).

<a id="the-3-2-1-rule"></a>
## 3-2-1 규칙

데이터 사본을 **3**개 두고, 서로 다른 저장 매체 **2**가지에 나눠 담고, 그중 **1**개는 다른 장소에 두세요. 사이드카만으로는 두 번째 사본 하나만 생기고, 그것도 데이터베이스와 *같은 디스크*에 있습니다. 실수(지운 페이지, 잘못된 업그레이드)는 막아 주지만 서버나 디스크를 잃는 일은 막지 못합니다. 다음 중 하나를 더하세요.

- `BACKUP_RCLONE_REMOTE`(오브젝트 스토리지, SFTP로 붙는 다른 서버, 마운트한 드라이브)
- `./deploy/backup.sh copy-out <latest> /some/other/disk`를 실행하는 호스트의 cron 작업
- 호스팅 업체가 제공하는 볼륨 스냅샷으로 백업 볼륨 찍어 두기

<a id="off-site-copies-with-rclone"></a>
## rclone으로 외부 사본 두기

먼저 rclone이 설치된 아무 컴퓨터에서 설정을 만들고(저장소 하나에 이름을 붙인 리모트를 만듭니다. 예를 들어 "b2") 그 파일을 서버로 복사합니다. 다음으로 `.env`에 리모트와 설정 파일 경로를 적습니다. 마지막으로 오버레이를 붙여 띄웁니다. 이 오버레이가 사이드카에 rclone 실행 파일을 더해 줍니다.

```bash
# 1. create a config on any machine with rclone installed, then copy it to the server
rclone config            # e.g. a remote called "b2"
cp ~/.config/rclone/rclone.conf /opt/inkling/rclone.conf

# 2. .env
BACKUP_RCLONE_REMOTE=b2:my-bucket/inkling
BACKUP_RCLONE_CONFIG=/opt/inkling/rclone.conf

# 3. start with the overlay (adds the rclone binary to the sidecar)
docker compose -f compose.yaml -f deploy/compose.backup-rclone.yaml up -d
```

실행이 성공할 때마다 새 세트를 올리고(`manifest.json`은 맨 마지막에 올립니다. 그래서 manifest가 없는 원격 세트는 덜 올라간 것으로 보고 무시합니다), `rclone check`로 확인한 다음, **같은 GFS 정책을 원격에도 따로 적용합니다**. 일부러 `rclone sync`를 쓰지 않았습니다. 새로 만들었거나 비워진 로컬 볼륨 때문에 원격에 쌓인 기록이 지워지면 안 되기 때문입니다. 업로드가 실패하면 백업이 실패했을 때와 똑같이 알립니다. 원격 저장소가 내 관리 아래 있지 않다면 `BACKUP_PASSPHRASE`를 쓰세요.

<a id="encryption"></a>
## 암호화

`BACKUP_PASSPHRASE`를 설정하면 두 본체 파일을 쓰는 동안 바로 암호화합니다(평문은 디스크에 한 번도 닿지 않습니다). 쓰는 방식은 이렇습니다.

```
openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 -salt
```

`manifest.json`과 `SHA256SUMS`는 읽을 수 있는 채로 둡니다(노트 내용은 없고 테이블 이름, 행 수, 체크섬만 있습니다). 그래서 키 없이도 세트 목록을 보고 검증할 수 있습니다. 관리자 페이지에서 내려받는 파일은 저장된 그대로, 즉 암호화된 상태입니다. 손으로 풀려면 이렇게 합니다.

```bash
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 -in db.dump.enc -out db.dump
```

> **패스프레이즈를 잃어버리면 암호화된 백업은 복원할 수 없습니다. 누구도 되찾아 줄 수 없습니다.**
> 패스프레이즈는 서버 밖에 보관하세요. 비밀번호 관리자에 넣고, 종이에도 적어 안전한 곳에 두세요. 백업하는 그 컴퓨터의 `.env`에만 두면 안 됩니다. 패스프레이즈를 바꾸면 새 세트에만 적용되므로, 옛 세트가 남아 있는 동안은 옛 패스프레이즈도 보관하세요.

체크섬을 곁들인 CBC는 내용을 숨겨 줄 뿐 변조까지 막아 주지는 않습니다. 백업 저장소에 쓸 수 있는 사람은 세트를 망가뜨릴 수 있습니다(sha256 확인이 알아채긴 하지만, manifest까지 다시 써 두었다면 알아채지 못합니다).

<a id="admin--backups"></a>
## 관리자 › 백업

- 상태: 마지막 성공과 실패, 다음 실행, 검증과 복원 테스트 결과, 원격 사본, 보관과 암호화, 그리고 실제로 적용된 설정(읽기 전용)을 보여 줍니다.
- **지금 백업**(`Back up now`)을 누르면 트리거 파일(`/backup-ctl/run.request`)이 생기고, 사이드카가 몇 초 안에 이를 알아채고 시작합니다. 실행이 대기 중이거나 도는 동안에는 버튼이 꺼집니다.
- **내려받기**(`Download`)는 세트를 압축하지 않은 `.tar`로 스트리밍합니다(관리자만, 브라우저 세션에서만).
- 가장 최근 실행이 실패했거나, 마지막 복원 테스트나 원격 사본이 실패했거나, 사이드카가 10분 동안 소식이 없으면 빨간 배너가 뜹니다. 이런 문제가 생길 때마다 모든 관리자에게 앱 안 알림이 가고, SMTP가 설정돼 있으면 메일도 갑니다.

<a id="restoring"></a>
## 복원

복원은 CLI로만 합니다. `deploy/restore.sh`는 실행 중인 `backup` 서비스에 일을 맡기는데, 복원에 필요한 도구와 패스프레이즈가 그 서비스에 있기 때문입니다. 먼저 `./deploy/backup.sh list`로 복원할 세트를 고릅니다. `--dry-run`을 붙이면 스크립트가 세트를 검증하고 모든 단계를 보여 주기만 할 뿐 아무것도 바꾸지 않습니다. 실제로 복원할 때는 스크립트가 세트 id를 직접 입력하라고 묻습니다.

```bash
./deploy/backup.sh list                         # pick a set
./deploy/restore.sh --dry-run 20261107-030000   # verify + show every step, change nothing
docker compose stop app
./deploy/restore.sh 20261107-030000             # asks you to type the set id
docker compose start app
```

스크립트가 하는 일은 이렇습니다.

1. manifest를 출력하고, sha256을 다시 확인하고, 복호화해서 `pg_restore --list`를 돌리고, 아카이브 목록을 봅니다.
2. 세트의 마이그레이션 수를 지금 체크아웃의 `apps/server/drizzle`과 비교합니다.
   - 백업이 코드보다 **새것**이면 경고하고 계속할지 묻습니다(먼저 맞는 버전을 체크아웃하세요).
   - 백업이 **오래된 것**이면 괜찮습니다. 앱이 다음에 시작할 때 새 마이그레이션을 적용합니다.
3. `app` 컨테이너가 돌고 있으면 진행하지 않습니다(`--stop-app`을 주면 멈추고 진행합니다).
4. 지금 상태를 안전 백업으로 받아 둡니다(`kind: pre-restore`). `--skip-pre-backup`으로 건너뛸 수 있습니다.
5. `DROP DATABASE … WITH (FORCE)`, `CREATE DATABASE`, `pg_restore`를 차례로 한 뒤 모든 테이블의 행 수를 manifest와 비교합니다.
6. 아카이브를 지금 데이터 옆에 풀고, 지금 데이터와 바꿔 끼운 다음 항목 수를 비교합니다.

옵션은 `--dry-run`, `--yes`(묻지 않음), `--stop-app`, `--skip-pre-backup`이 있습니다. 기본과 다른 compose 구성을 쓰신다면 `COMPOSE="docker compose -f compose.yaml -f deploy/compose.caddy.yaml" ./deploy/restore.sh …`처럼 명령을 넘겨 주세요.

<a id="restoring-on-a-new-server"></a>
### 새 서버에 복원하기

1. [DEPLOY.ko.md](../deploy/DEPLOY.ko.md)대로 Inkling을 설치합니다. 되도록 백업과 같은 버전으로 설치하세요.
2. `.env`에 같은 `BACKUP_PASSPHRASE`를 넣고 `docker compose up -d db backup`을 실행합니다(앱은 아직 띄우지 않습니다).
3. 세트를 볼륨 안으로 복사합니다. `docker cp ./20261107-030000 $(docker compose ps -q backup):/backups/sets/`를 쓰거나, rclone으로 받아 와도 됩니다(`rclone copy b2:my-bucket/inkling/20261107-030000 …`).
4. `./deploy/restore.sh --skip-pre-backup 20261107-030000`을 실행한 다음 `docker compose up -d`로 띄웁니다.

<a id="restore-rehearsal"></a>
### 복원 연습

한 번도 복원해 보지 않은 백업은 백업이 아니라 희망 사항일 뿐입니다. 주간 복원 테스트는 덤프가 제대로 들어가고 빠진 것이 없다는 것까지는 보여 주지만, *내가* 서비스를 되살릴 수 있다는 것까지 보여 주지는 않습니다. 몇 달에 한 번씩 이렇게 해 보세요.

1. 다른 컴퓨터에서, 또는 compose 프로젝트 이름을 바꿔서(`docker compose -p inkling-rehearsal …`, 호스트 포트도 다르게) 버려도 되는 사본을 띄웁니다.
2. "새 서버에 복원하기"를 따라 가장 새 외부 세트를 그곳에 복원합니다.
3. 로그인해서 페이지와 첨부 파일을 몇 개 열어 본 다음 `docker compose -p inkling-rehearsal down -v`로 지웁니다.

얼마나 걸렸는지 적어 두세요. 그게 실제로 복구하는 데 드는 시간입니다.

<a id="troubleshooting"></a>
## 문제 해결

| 증상 | 해결 |
|---|---|
| "not enough free disk space" | 기한이 지난 세트는 이 확인 전에 이미 정리했으므로, 남겨 둔 세트와 이번 실행분이 들어갈 자리가 없다는 뜻입니다. 백업 볼륨의 공간을 비우거나, `BACKUP_KEEP_*`를 낮추거나(다음 실행부터 적용), `BACKUP_MIN_FREE_MB`를 낮추거나, 볼륨을 옮기세요. |
| "set is encrypted but BACKUP_PASSPHRASE is not set" | 그 세트를 만들 때 쓴 패스프레이즈를 `.env`에 넣으세요. |
| "backup service has not reported" | `docker compose ps backup`, `docker compose logs backup`으로 확인하세요. |
| "rclone binary missing" | `-f deploy/compose.backup-rclone.yaml`을 붙여서 띄우세요. |
| rclone: "config file … is a directory" | `up` 하기 전에 `BACKUP_RCLONE_CONFIG`가 실제로 있는 파일을 가리켜야 합니다. 그렇지 않으면 Docker가 그 경로에 빈 디렉터리를 만듭니다. 그 디렉터리를 지우고 파일을 만든 뒤 다시 `up -d` 하세요. |
| Postgres를 올린 뒤 pg_dump 버전이 맞지 않음 | 사이드카 이미지의 메이저 버전이 `db` 서비스와 같아야 합니다(둘 다 16). |
