# Reference infrastructure for GCP (§10). Review and `terraform plan` in a scratch project before use:
# this configuration has not been applied against a live project by the authors of this repository.
terraform {
  required_version = ">= 1.6"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 6.0" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

locals {
  name = "crm-bee"
}

resource "google_project_service" "apis" {
  for_each = toset([
    "compute.googleapis.com", "sqladmin.googleapis.com", "redis.googleapis.com", "secretmanager.googleapis.com",
    "servicenetworking.googleapis.com", "monitoring.googleapis.com", "logging.googleapis.com", "storage.googleapis.com",
  ])
  service            = each.key
  disable_on_destroy = false
}

# ── Network: private-only data plane ────────────────────────────────────────────
resource "google_compute_network" "vpc" {
  name                    = "${local.name}-vpc"
  auto_create_subnetworks = false
  depends_on              = [google_project_service.apis]
}

resource "google_compute_subnetwork" "app" {
  name                     = "${local.name}-app"
  ip_cidr_range            = "10.20.0.0/24"
  region                   = var.region
  network                  = google_compute_network.vpc.id
  private_ip_google_access = true
}

resource "google_compute_global_address" "private_services" {
  name          = "${local.name}-private-services"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 20
  network       = google_compute_network.vpc.id
}

resource "google_service_networking_connection" "private" {
  network                 = google_compute_network.vpc.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_services.name]
}

resource "google_compute_router" "nat" {
  name    = "${local.name}-router"
  region  = var.region
  network = google_compute_network.vpc.id
}

resource "google_compute_router_nat" "nat" {
  name                               = "${local.name}-nat"
  router                             = google_compute_router.nat.name
  region                             = var.region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"
}

resource "google_compute_firewall" "lb_to_app" {
  name    = "${local.name}-lb-to-app"
  network = google_compute_network.vpc.name
  allow {
    protocol = "tcp"
    ports    = ["3000"]
  }
  source_ranges = ["130.211.0.0/22", "35.191.0.0/16"] # Google front ends / health checks
  target_tags   = ["crm-bee-app"]
}

resource "google_compute_firewall" "iap_ssh" {
  name    = "${local.name}-iap-ssh"
  network = google_compute_network.vpc.name
  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
  source_ranges = ["35.235.240.0/20"]
  target_tags   = ["crm-bee-app"]
}

# ── PostgreSQL 16 (application DB and Twenty's DB are separate databases/roles) ──
resource "random_password" "db" {
  for_each = toset(["crmbee_owner", "crmbee_app", "twenty"])
  length   = 32
  special  = false
}

resource "google_sql_database_instance" "pg" {
  name                = "${local.name}-pg"
  database_version    = "POSTGRES_16"
  region              = var.region
  deletion_protection = true
  depends_on          = [google_service_networking_connection.private]

  settings {
    tier              = var.db_tier
    edition           = "ENTERPRISE"
    availability_type = "REGIONAL"
    disk_type         = "PD_SSD"
    disk_size         = var.db_disk_gb
    disk_autoresize   = true

    ip_configuration {
      ipv4_enabled    = false
      private_network = google_compute_network.vpc.id
      ssl_mode        = "ENCRYPTED_ONLY" # SEC-01: TLS enforced
    }
    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true # WAL archiving → RPO well under 15 minutes
      transaction_log_retention_days = 7
      start_time                     = "21:00"
      backup_retention_settings { retained_backups = 14 }
    }
    database_flags {
      name  = "max_connections"
      value = "300"
    }
    insights_config { query_insights_enabled = true }
    maintenance_window {
      day  = 7
      hour = 21
    }
  }
}

resource "google_sql_database" "crmbee" {
  name     = "crmbee"
  instance = google_sql_database_instance.pg.name
}

resource "google_sql_database" "twenty" {
  name     = "twenty"
  instance = google_sql_database_instance.pg.name
}

resource "google_sql_user" "users" {
  for_each = random_password.db
  name     = each.key
  instance = google_sql_database_instance.pg.name
  password = each.value.result
}

# ── Redis: rate-limit counters and leases only (no business state) ───────────────
resource "google_redis_instance" "limiter" {
  name                    = "${local.name}-redis"
  tier                    = "STANDARD_HA"
  memory_size_gb          = var.redis_memory_gb
  region                  = var.region
  redis_version           = "REDIS_7_0"
  authorized_network      = google_compute_network.vpc.id
  connect_mode            = "PRIVATE_SERVICE_ACCESS"
  auth_enabled            = true
  transit_encryption_mode = "SERVER_AUTHENTICATION"
  depends_on              = [google_service_networking_connection.private]
}

# ── Private media bucket (tenant-prefixed keys; no public access) ────────────────
resource "google_storage_bucket" "media" {
  name                        = "${var.project_id}-${local.name}-media"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  lifecycle_rule {
    condition { age = var.media_retention_backstop_days }
    action { type = "Delete" }
  }
}

# ── Identity and secrets ─────────────────────────────────────────────────────────
resource "google_service_account" "app" {
  account_id   = "${local.name}-app"
  display_name = "CRM Bee application nodes"
}

resource "google_project_iam_member" "app_roles" {
  for_each = toset(["roles/secretmanager.secretAccessor", "roles/cloudsql.client", "roles/logging.logWriter", "roles/monitoring.metricWriter"])
  project  = var.project_id
  role     = each.key
  member   = "serviceAccount:${google_service_account.app.email}"
}

resource "google_storage_bucket_iam_member" "app_media" {
  bucket = google_storage_bucket.media.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.app.email}"
}

# S3-interoperability HMAC key (Twenty and the media service speak the S3 API). Test signing/CORS before go-live (§10).
resource "google_storage_hmac_key" "media" {
  service_account_email = google_service_account.app.email
}

resource "random_password" "app_secrets" {
  for_each = toset(["jwt-secret", "admin-api-key"])
  length   = 48
  special  = false
}

locals {
  generated_secrets = {
    "jwt-secret"        = random_password.app_secrets["jwt-secret"].result
    "admin-api-key"     = random_password.app_secrets["admin-api-key"].result
    "db-owner-url"      = "postgresql://crmbee_owner:${random_password.db["crmbee_owner"].result}@${google_sql_database_instance.pg.private_ip_address}:5432/crmbee?sslmode=require"
    "db-app-url"        = "postgresql://crmbee_app:${random_password.db["crmbee_app"].result}@${google_sql_database_instance.pg.private_ip_address}:5432/crmbee?sslmode=require"
    "twenty-db-url"     = "postgresql://twenty:${random_password.db["twenty"].result}@${google_sql_database_instance.pg.private_ip_address}:5432/twenty?sslmode=require"
    "s3-access-key"     = google_storage_hmac_key.media.access_id
    "s3-secret-key"     = google_storage_hmac_key.media.secret
    "redis-url"         = "rediss://:${google_redis_instance.limiter.auth_string}@${google_redis_instance.limiter.host}:${google_redis_instance.limiter.port}"
  }
  # Provider credentials are supplied by operators: create these versions after terraform apply.
  manual_secrets = ["whatsapp-verify-token", "whatsapp-app-secret", "whatsapp-access-token", "teams-app-password", "openai-api-key", "email-webhook-secrets", "metrics-token"]
}

resource "google_secret_manager_secret" "generated" {
  for_each  = local.generated_secrets
  secret_id = "${local.name}-${each.key}"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "generated" {
  for_each    = local.generated_secrets
  secret      = google_secret_manager_secret.generated[each.key].id
  secret_data = each.value
}

resource "google_secret_manager_secret" "manual" {
  for_each  = toset(local.manual_secrets)
  secret_id = "${local.name}-${each.key}"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

# ── Application nodes (one in each zone) ─────────────────────────────────────────
resource "google_compute_instance" "app" {
  count        = length(var.zones)
  name         = "${local.name}-app-${count.index + 1}"
  machine_type = var.app_machine_type
  zone         = var.zones[count.index]
  tags         = ["crm-bee-app"]

  boot_disk {
    initialize_params {
      image = "ubuntu-os-cloud/ubuntu-2404-lts-amd64"
      size  = 60
      type  = "pd-ssd"
    }
  }
  network_interface {
    subnetwork = google_compute_subnetwork.app.id # no external IP: egress via Cloud NAT
  }
  service_account {
    email  = google_service_account.app.email
    scopes = ["cloud-platform"]
  }
  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }
  metadata = {
    enable-oslogin         = "TRUE"
    block-project-ssh-keys = "TRUE"
  }
  metadata_startup_script = templatefile("${path.module}/startup.sh.tftpl", {
    image         = var.image
    project       = var.project_id
    run_scheduler = count.index == 0
    prefix        = local.name
    bucket        = google_storage_bucket.media.name
    twenty_url    = "https://${var.domain}"
  })
  depends_on = [google_project_iam_member.app_roles, google_secret_manager_secret_version.generated, google_router_nat.nat]
}

resource "google_compute_instance_group" "app" {
  count     = length(var.zones)
  name      = "${local.name}-ig-${count.index + 1}"
  zone      = var.zones[count.index]
  instances = [google_compute_instance.app[count.index].self_link]
  named_port {
    name = "http"
    port = 3000
  }
}

# ── HTTPS load balancer with Cloud Armor ─────────────────────────────────────────
resource "google_compute_health_check" "app" {
  name = "${local.name}-hc"
  http_health_check {
    port         = 3000
    request_path = "/health/ready"
  }
  check_interval_sec  = 10
  timeout_sec         = 5
  unhealthy_threshold = 3
}

resource "google_compute_security_policy" "edge" {
  name = "${local.name}-edge"
  rule {
    action   = "throttle"
    priority = 1000
    match {
      versioned_expr = "SRC_IPS_V1"
      config { src_ip_ranges = ["*"] }
    }
    rate_limit_options {
      conform_action = "allow"
      exceed_action  = "deny(429)"
      enforce_on_key = "IP"
      rate_limit_threshold {
        count        = 600
        interval_sec = 60
      }
    }
  }
  rule {
    action   = "allow"
    priority = 2147483647
    match {
      versioned_expr = "SRC_IPS_V1"
      config { src_ip_ranges = ["*"] }
    }
  }
}

resource "google_compute_backend_service" "app" {
  name                  = "${local.name}-backend"
  protocol              = "HTTP"
  port_name             = "http"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  timeout_sec           = 30
  health_checks         = [google_compute_health_check.app.id]
  security_policy       = google_compute_security_policy.edge.id
  dynamic "backend" {
    for_each = google_compute_instance_group.app
    content {
      group           = backend.value.id
      balancing_mode  = "UTILIZATION"
      max_utilization = 0.8
    }
  }
  log_config { enable = true }
}

resource "google_compute_global_address" "lb" { name = "${local.name}-ip" }

resource "google_compute_managed_ssl_certificate" "cert" {
  name = "${local.name}-cert"
  managed { domains = [var.domain] }
}

resource "google_compute_url_map" "map" {
  name            = "${local.name}-urlmap"
  default_service = google_compute_backend_service.app.id
}

resource "google_compute_target_https_proxy" "https" {
  name             = "${local.name}-https"
  url_map          = google_compute_url_map.map.id
  ssl_certificates = [google_compute_managed_ssl_certificate.cert.id]
  ssl_policy       = google_compute_ssl_policy.modern.id
}

resource "google_compute_ssl_policy" "modern" {
  name            = "${local.name}-tls"
  profile         = "MODERN"
  min_tls_version = "TLS_1_2"
}

resource "google_compute_global_forwarding_rule" "https" {
  name                  = "${local.name}-https"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  target                = google_compute_target_https_proxy.https.id
  port_range            = "443"
  ip_address            = google_compute_global_address.lb.address
}

# ── Monitoring ───────────────────────────────────────────────────────────────────
resource "google_monitoring_notification_channel" "email" {
  display_name = "CRM Bee operators"
  type         = "email"
  labels       = { email_address = var.alert_email }
}

resource "google_monitoring_uptime_check_config" "ready" {
  display_name = "${local.name} readiness"
  timeout      = "10s"
  period       = "60s"
  http_check {
    path         = "/health/ready"
    port         = 443
    use_ssl      = true
    validate_ssl = true
  }
  monitored_resource {
    type   = "uptime_url"
    labels = { project_id = var.project_id, host = var.domain }
  }
}

resource "google_monitoring_alert_policy" "uptime" {
  display_name = "${local.name} readiness failing"
  combiner     = "OR"
  conditions {
    display_name = "uptime check failing"
    condition_threshold {
      filter          = "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND resource.type=\"uptime_url\" AND metric.label.check_id=\"${google_monitoring_uptime_check_config.ready.uptime_check_id}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 1
      duration        = "300s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_NEXT_OLDER"
        cross_series_reducer = "REDUCE_COUNT_FALSE"
        group_by_fields      = ["resource.label.*"]
      }
    }
  }
  notification_channels = [google_monitoring_notification_channel.email.id]
}

resource "google_monitoring_alert_policy" "db_cpu" {
  display_name = "${local.name} database CPU > 70% for 15 min"
  combiner     = "OR"
  conditions {
    display_name = "cloudsql cpu"
    condition_threshold {
      filter          = "metric.type=\"cloudsql.googleapis.com/database/cpu/utilization\" AND resource.type=\"cloudsql_database\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0.7
      duration        = "900s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MEAN"
      }
    }
  }
  notification_channels = [google_monitoring_notification_channel.email.id]
}
