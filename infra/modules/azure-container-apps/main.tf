terraform {
  required_version = ">= 1.0"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.0"
    }
  }
}

# Resource Group
resource "azurerm_resource_group" "main" {
  count    = var.create_resource_group ? 1 : 0
  name     = var.resource_group_name
  location = var.location
  tags     = var.tags
}

# Log Analytics Workspace
resource "azurerm_log_analytics_workspace" "main" {
  name                = "${var.app_name}-logs"
  location            = var.location
  resource_group_name = var.create_resource_group ? azurerm_resource_group.main[0].name : var.existing_resource_group_name
  sku                 = "PerGB2018"
  retention_in_days   = 30
  tags                = var.tags
}

# Container Apps Environment
resource "azurerm_container_apps_environment" "main" {
  name                         = "${var.app_name}-env"
  location                     = var.location
  resource_group_name          = var.create_resource_group ? azurerm_resource_group.main[0].name : var.existing_resource_group_name
  log_analytics_workspace_id   = azurerm_log_analytics_workspace.main.id
  infrastructure_subnet_id     = var.subnet_id
  internal_load_balancer_enabled = false
  tags                         = var.tags
}

# Container App
resource "azurerm_container_app" "main" {
  name                         = var.app_name
  location                     = var.location
  resource_group_name          = var.create_resource_group ? azurerm_resource_group.main[0].name : var.existing_resource_group_name
  container_app_environment_id = azurerm_container_apps_environment.main.id
  revision_mode                = "Single"
  tags                         = var.tags

  template {
    min_replicas = var.min_replicas
    max_replicas = var.max_replicas

    container {
      name   = var.app_name
      image  = var.image_url
      cpu    = var.cpu
      memory = var.memory
      env {
        name  = "NODE_ENV"
        value = var.environment
      }

      dynamic "env" {
        for_each = var.environment_variables
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = var.secrets
        content {
          name        = env.value.name
          secret_name = env.key
        }
      }
    }
  }

  ingress {
    allow_insecure_connections = false
    external_enabled           = true
    target_port               = var.container_port
    transport                 = "auto"

    traffic_weight {
      percentage      = 100
      latest_revision = true
    }
  }
}

# Container App Secrets
resource "azurerm_container_app_secret" "main" {
  for_each = var.secrets

  name                     = each.key
  container_app_id         = azurerm_container_app.main.id
  secret_name_reference    = each.key
  key_vault_secret_id      = each.value.key_vault_secret_id
}

# Application Insights
resource "azurerm_application_insights" "main" {
  name                = "${var.app_name}-ai"
  location            = var.location
  resource_group_name = var.create_resource_group ? azurerm_resource_group.main[0].name : var.existing_resource_group_name
  workspace_id        = azurerm_log_analytics_workspace.main.id
  application_type    = "other"
  tags                = var.tags
}
