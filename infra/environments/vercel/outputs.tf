output "deployment_url" {
  description = "URL of the Vercel deployment"
  value       = module.vercel.deployment_url
}

output "project_id" {
  description = "ID of the Vercel project"
  value       = module.vercel.project_id
}

output "project_name" {
  description = "Name of the Vercel project"
  value       = module.vercel.project_name
}

output "domains" {
  description = "List of project domains"
  value       = module.vercel.domains
}
