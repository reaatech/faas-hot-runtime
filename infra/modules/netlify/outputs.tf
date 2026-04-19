output "site_id" {
  description = "ID of the Netlify site"
  value       = netlify_site.main.id
}

output "site_url" {
  description = "URL of the Netlify site"
  value       = netlify_site.main.ssl_url
}

output "admin_url" {
  description = "Admin URL of the Netlify site"
  value       = netlify_site.main.admin_url
}

output "deploy_url" {
  description = "URL of the latest deploy"
  value       = netlify_deploy.main.deploy_ssl_url
}

output "deploy_id" {
  description = "ID of the latest deploy"
  value       = netlify_deploy.main.id
}
