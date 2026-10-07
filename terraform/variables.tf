variable "project_id" { type = string }
variable "region" {
  type    = string
  default = "asia-south1"
}
variable "zones" {
  type        = list(string)
  default     = ["asia-south1-a", "asia-south1-b"]
  description = "Two zones for the two application nodes (§10: avoid single-host dependence)."
}
variable "domain" {
  type        = string
  description = "Public hostname for webhooks/API, e.g. bee.example.com (managed certificate)."
}
variable "image" {
  type        = string
  description = "Pinned application image, e.g. asia-south1-docker.pkg.dev/PROJECT/crm-bee/app:1.0.0 (never :latest)."
}
variable "app_machine_type" {
  type    = string
  default = "n2-standard-4" # 4 vCPU / 16 GB, §10 baseline (Twenty + API + workers share the node)
}
variable "db_tier" {
  type    = string
  default = "db-custom-4-16384"
}
variable "db_disk_gb" {
  type    = number
  default = 100
}
variable "redis_memory_gb" {
  type    = number
  default = 2
}
variable "alert_email" { type = string }
variable "media_retention_backstop_days" {
  type        = number
  default     = 45
  description = "Bucket lifecycle backstop; the application deletes media at 24 h (abandoned) / 30 d (confirmed)."
}
