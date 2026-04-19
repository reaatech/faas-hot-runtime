terraform {
  required_version = ">= 1.0"
  required_providers {
    vercel = {
      source  = "vercel/vercel"
      version = "~> 1.0"
    }
  }
}

provider "vercel" {
  # API token from VERCEL_TOKEN environment variable
}

# Vercel Module
module "vercel" {
  source = "../../modules/vercel"

  project_name = "${var.service_name}-${var.environment}"
  team_id      = var.team_id
  environment  = var.environment
  framework    = var.framework
  repo         = var.repo

  production_branch = var.production_branch
  ref               = var.ref
  production        = var.environment == "production"

  environment_variables = {
    LOG_LEVEL        = var.environment == "production" ? "info" : "debug"
    MCP_TRANSPORT    = "http"
    POOL_MIN_SIZE    = var.pool_min_size
    POOL_MAX_SIZE    = var.pool_max_size
  }

  secrets = {
    DATABASE_URL  = var.database_url
    REDIS_URL     = var.redis_url
    OTEL_ENDPOINT = var.otel_endpoint
  }

  domains = var.domains
}
