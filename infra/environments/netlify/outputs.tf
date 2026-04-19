output "site_url" {
  description = "URL of the Netlify site"
  value       = module.netlify.site_url
}

output "site_id" {
  description = "ID of the Netlify site"
  value       = module.netlify.site_id
}

output "admin_url" {
  description = "Admin URL of the Netlify site"
  value       = module.netlify.admin_url
}

output "deploy_url" {
  description = "URL of the latest deploy"
  value       = module.netlify.deploy_url
}
