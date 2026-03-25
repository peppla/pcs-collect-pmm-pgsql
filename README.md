# pcs-collect-pmm-pgsql

Collect PMM (Percona Monitoring and Management) Grafana dashboard panels
as PNG screenshots for PostgreSQL audits. Uses Playwright to render panels
in a headless Chromium browser — no Grafana image-renderer plugin required.

## Dashboards collected

- **PostgreSQL Instance Summary** — connections, queries, locks, replication, etc.
- **Node Instance Summary** — CPU, memory, disk, network (skipped for RDS/Aurora)
- **Security Checks** — PMM advisor check results saved as JSON

## Requirements

- Node.js 18+
- Network access to the target PMM server

## Install

```bash
npm install
```

This installs dependencies and automatically downloads Chromium via Playwright's `postinstall` hook.

If Chromium download fails or is skipped, run manually:

```bash
npx playwright install chromium
```

## Usage

### List available nodes and services

```bash
node pcs-collect-pmm-pgsql.mjs https://USER:PASS@pmm-server --list
```

### Collect dashboards (last 24 hours)

```bash
node pcs-collect-pmm-pgsql.mjs https://USER:PASS@pmm-server \
  --node myhost \
  --service myhost-pgsql
```

### Collect with API key instead of embedded credentials

```bash
node pcs-collect-pmm-pgsql.mjs https://pmm-server \
  --apikey YOUR_API_KEY \
  --node myhost \
  --service myhost-pgsql
```

### Collect a specific time range

```bash
node pcs-collect-pmm-pgsql.mjs https://USER:PASS@pmm-server \
  --node myhost \
  --service myhost-pgsql \
  --start 2025-03-01T00:00:00 \
  --end 2025-03-02T00:00:00
```

### RDS / Aurora

```bash
node pcs-collect-pmm-pgsql.mjs https://USER:PASS@pmm-server \
  --node myhost \
  --service myhost-pgsql \
  --rds
```

The `--rds` and `--aurora` flags automatically skip OS/Node-level graphs
since those metrics are not available on managed databases.

## Options

| Option | Description | Default |
| --- | --- | --- |
| `<pmmserver>` | PMM server URL (`https://user:pass@host`) | *required* |
| `--node <name>` | Node name of the audit target | *required* |
| `--service <name>` | Service name (e.g. `myhost-pgsql`) | *required* |
| `--list` | List nodes and services, then exit | |
| `--apikey <key>` | Use API key instead of URL credentials | |
| `--start <datetime>` | Start time (`YYYY-MM-DDTHH:MM:SS` UTC) | now - 24h |
| `--end <datetime>` | End time (`YYYY-MM-DDTHH:MM:SS` UTC) | now |
| `--interval <interval>` | Data point resolution (`5s`, `1h`, `1d`, ...) | `5s` |
| `--database <name>` | PostgreSQL database to filter metrics | `all` |
| `--width <pixels>` | Screenshot width | `1280` |
| `--height <pixels>` | Screenshot height | `720` |
| `--extra <string>` | Append string to output directory name | |
| `--notar` | Skip `.tgz` compression of output | |
| `--skip-pgsql` | Skip PostgreSQL dashboard | |
| `--skip-os` | Skip Node/OS dashboard | |
| `--skip-security` | Skip security checks collection | |
| `--rds` | Amazon RDS PostgreSQL (skips OS graphs) | |
| `--aurora` | Amazon Aurora PostgreSQL (skips OS graphs) | |
| `-v, --verbose` | Verbose output for debugging | |

## Output

Screenshots are saved to a directory named `<hostname>_pmm_<date>/`
and compressed to `<hostname>_pmm_<date>.tgz` (unless `--notar` is used).

``` text
myhost_pmm_2025-03-01/
  postgresql-instance-summary_Connections_Overview.png
  postgresql-instance-summary_Tuple_Operations.png
  ...
  node-instance-summary_CPU_Usage.png
  ...
  security_checks            # JSON file
myhost_pmm_2025-03-01.tgz
```
