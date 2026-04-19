output "service_url" {
  description = "Cloud Run service URL"
  value       = google_cloud_run_v2_service.main.uri
}

output "service_name" {
  description = "Cloud Run service name"
  value       = google_cloud_run_v2_service.main.name
}

output "service_location" {
  description = "Cloud Run service location"
  value       = google_cloud_run_v2_service.main.location
}

output "service_account_email" {
  description = "Service account email"
  value       = google_service_account.faas_sa.email
}

output "service_id" {
  description = "Cloud Run service ID"
  value       = google_cloud_run_v2_service.main.id
}
