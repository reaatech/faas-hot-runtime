output "container_app_id" {
  description = "ID of the Container App"
  value       = azurerm_container_app.main.id
}

output "container_app_name" {
  description = "Name of the Container App"
  value       = azurerm_container_app.main.name
}

output "container_app_fqdn" {
  description = "FQDN of the Container App"
  value       = azurerm_container_app.main.latest_revision_fqdn
}

output "container_app_url" {
  description = "URL of the Container App"
  value       = "https://${azurerm_container_app.main.latest_revision_fqdn}"
}

output "resource_group_name" {
  description = "Name of the resource group"
  value       = var.create_resource_group ? azurerm_resource_group.main[0].name : var.existing_resource_group_name
}

output "resource_group_id" {
  description = "ID of the resource group"
  value       = var.create_resource_group ? azurerm_resource_group.main[0].id : null
}

output "container_apps_environment_id" {
  description = "ID of the Container Apps Environment"
  value       = azurerm_container_apps_environment.main.id
}

output "log_analytics_workspace_id" {
  description = "ID of the Log Analytics Workspace"
  value       = azurerm_log_analytics_workspace.main.id
}

output "application_insights_id" {
  description = "ID of the Application Insights resource"
  value       = azurerm_application_insights.main.id
}

output "application_insights_instrumentation_key" {
  description = "Instrumentation key for Application Insights"
  value       = azurerm_application_insights.main.instrumentation_key
  sensitive   = true
}
