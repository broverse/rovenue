# Grafana dashboards

`rovenue-api-red.json` is provisioned automatically. For infra, download these community
dashboards into this directory (they bind to the `prometheus` datasource UID):

- Postgres (postgres-exporter): grafana.com dashboard ID **9628**
- Redis (redis_exporter): grafana.com dashboard ID **763**
- ClickHouse: grafana.com dashboard ID **14192**
- Redpanda: grafana.com dashboard ID **18135**

After downloading each JSON, set its datasource references to the `prometheus` UID and place
the file here; the file provider picks it up within 30s. They are NOT committed by default to
avoid vendoring large third-party JSON; commit them if you want them in the image.
