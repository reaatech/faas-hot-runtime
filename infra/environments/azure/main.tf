terraform {
  required_version = ">= 1.0"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.0"
    }
  }
  backend "azurerm" {
    resource_group_name  = "faas-hot-runtime-tfstate-rg"
    storage_account_name = "faashotstatstorage"
    container_name       = "tfstate"
    key                  = "azure/terraform.tfstate"
  }
}

provider "azurerm" {
  features {}
}

# Resource Group
resource "azurerm_resource_group" "main" {
  name     = "${var.service_name}-${var.environment}-rg"
  location = var.location
  tags = {
    Environment = var.environment
    ManagedBy   = "terraform"
    Project     = "faas-hot-runtime"
  }
}

# Virtual Network
resource "azurerm_virtual_network" "main" {
  name                = "${var.service_name}-vnet"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  address_space       = ["10.0.0.0/16"]
  tags = {
    Name = "${var.service_name}-vnet"
  }
}

# Subnet for Container Apps
resource "azurerm_subnet" "container_apps" {
  name                 = "container-apps-subnet"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = ["10.0.1.0/24"]

  delegation {
    name = "delegation"

    service_delegation {
      name    = "Microsoft.App/environments"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

# Azure Database for PostgreSQL
resource "azurerm_postgresql_server" "main" {
  name                = "${var.service_name}-${var.environment}-pg"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name

  sku_name = var.db_sku_name

  version                   = var.db_version
  administrator_login       = var.db_admin_username
  administrator_login_password = var.db_admin_password

  storage_mb                   = var.db_storage_mb
  backup_retention_days        = var.environment == "production" ? 35 : 7
  geo_redundant_backup_enabled = var.environment == "production"
  auto_grow_enabled            = true
  ssl_enforcement_enabled      = true
  ssl_minimal_tls_version_enforced = "TLS1_2"

  tags = {
    Name = "${var.service_name}-pg"
  }
}

# Azure Cache for Redis
resource "azurerm_redis_cache" "main" {
  name                = "${var.service_name}-${var.environment}-redis"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  capacity            = var.redis_capacity
  family              = var.redis_family
  sku_name            = var.redis_sku_name

  enable_non_ssl_port = false
  minimum_tls_version = "1.2"

  redis_configuration {
    maxmemory_reserved = var.redis_maxmemory_reserved
    maxmemory_delta    = var.redis_maxmemory_delta
  }

  tags = {
    Name = "${var.service_name}-redis"
  }
}

# Storage Account for function artifacts
resource "azurerm_storage_account" "main" {
  name                     = "${var.service_name}${var.environment}storage"
  location                 = azurerm_resource_group.main.location
  resource_group_name      = azurerm_resource_group.main.name
  account_tier             = "Standard"
  account_replication_type = var.environment == "production" ? "GRS" : "LRS"

  tags = {
    Name = "${var.service_name}-storage"
  }
}

# Container Apps Module
module "container_apps" {
  source = "../../modules/azure-container-apps"

  app_name    = var.service_name
  location    = azurerm_resource_group.main.location
  image_url   = var.image_url

  environment = var.environment
  subnet_id   = azurerm_subnet.container_apps.id

  min_replicas = var.environment == "production" ? 2 : 0
  max_replicas = var.environment == "production" ? 10 : 4

  cpu    = var.container_cpu
  memory = var.container_memory

  environment_variables = {
    NODE_ENV         = var.environment
    LOG_LEVEL        = var.environment == "production" ? "info" : "debug"
    DATABASE_URL     = "postgres://${var.db_admin_username}:${var.db_admin_password}@${azurerm_postgresql_server.main.fqdn}:5432/${var.db_name}"
    REDIS_URL        = "redis://${azurerm_redis_cache.main.hostname}:${azurerm_redis_cache.main.port}"
    STORAGE_ACCOUNT  = azurerm_storage_account.main.name
    OTEL_EXPORTER    = "otlp"
    OTEL_ENDPOINT    = var.otel_endpoint
    MCP_TRANSPORT    = "http"
    POOL_MIN_SIZE    = var.pool_min_size
    POOL_MAX_SIZE    = var.pool_max_size
  }

  tags = {
    Environment = var.environment
    Project     = "faas-hot-runtime"
  }
}

# Application Insights for monitoring
resource "azurerm_application_insights" "main" {
  name                = "${var.service_name}-ai"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  application_type    = "other"

  tags = {
    Name = "${var.service_name}-ai"
  }
}
