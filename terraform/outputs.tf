output "load_balancer_ip" {
  value       = google_compute_global_address.lb.address
  description = "Point the DNS A record for var.domain here."
}
output "db_private_ip" { value = google_sql_database_instance.pg.private_ip_address }
output "media_bucket" { value = google_storage_bucket.media.name }
output "manual_secrets_to_populate" {
  value       = [for s in google_secret_manager_secret.manual : s.secret_id]
  description = "Create a version for each of these in Secret Manager before the first deploy."
}
output "app_service_account" { value = google_service_account.app.email }
