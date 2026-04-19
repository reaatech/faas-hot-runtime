terraform {
  required_version = ">= 1.0"
  required_providers {
    netlify = {
      source  = "netlify/netlify"
      version = "~> 2.0"
    }
  }
}

provider "netlify" {
  # API token from NETLIFY_AUTH_TOKEN environment variable
}

# Netlify Module
module "netlify" {
  source = "../../modules/netlify"

  site_name     = "${var.service_name}-${var.environment}"
  account_slug  = var.account_slug
  environment   = var.environment
  custom_domain = var.custom_domain
  force_ssl     = true

  build_dir     = var.build_dir
  functions_dir = "netlify/functions"
  node_version  = var.node_version

  build_env = {
    NODE_ENV      = var.environment
    LOG_LEVEL     = var.environment == "production" ? "info" : "debug"
    MCP_TRANSPORT = "http"
    POOL_MIN_SIZE = var.pool_min_size
    POOL_MAX_SIZE = var.pool_max_size
  }

  secrets = {
    DATABASE_URL     = var.database_url
    REDIS_URL        = var.redis_url
    OTEL_ENDPOINT    = var.otel_endpoint
  }

  custom_headers = {
    "/*" = {
      "X-Frame-Options"         = "DENY"
      "X-Content-Type-Options"  = "nosniff"
      "X-XSS-Protection"        = "1; mode=block"
      "Referrer-Policy"         = "strict-origin-when-cross-origin"
    }
  }

  redirects = [
    {
      from   = "/api/*"
      to     = "/.netlify/functions/:splat"
      status = 200
    },
    {
      from   = "/*"
      to     = "/index.html"
      status = 200
      condition = {
        role = "anonymous"
      }
    }
  ]
}
