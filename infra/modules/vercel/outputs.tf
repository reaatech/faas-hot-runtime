output "project_id" {
  description = "ID of the Vercel project"
  value       = vercel_project.main.id
}

output "project_name" {
  description = "Name of the Vercel project"
  value       = vercel_project.main.name
}

output "deployment_url" {
  description = "URL of the deployment"
  value       = vercel_deployment.main.url
}

output "deployment_id" {
  description = "ID of the deployment"
  value       = vercel_deployment.main.id
}

output "domains" {
  description = "List of project domains"
  value       = [for d in vercel_project_domain.main : d.domain]
}
