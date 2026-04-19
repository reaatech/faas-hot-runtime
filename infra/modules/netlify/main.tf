terraform {
  required_version = ">= 1.0"
  required_providers {
    netlify = {
      source  = "netlify/netlify"
      version = "~> 2.0"
    }
  }
}

# Netlify Site
resource "netlify_site" "main" {
  name           = var.site_name
  account_slug   = var.account_slug
  custom_domain  = var.custom_domain
  force_ssl      = var.force_ssl
  processing_settings {
    css {
      bundle = var.css_bundle
      minify = var.css_minify
    }
    js {
      bundle = var.js_bundle
      minify = var.js_minify
    }
    html {
      pretty_urls = var.pretty_urls
    }
    images {
      compress = var.image_compress
    }
  }
}

# Site Deploy from Git
resource "netlify_deploy" "main" {
  site_id        = netlify_site.main.id
  build_dir      = var.build_dir
  functions_dir  = var.functions_dir
  env = {
    NODE_ENV     = var.environment
    NODE_VERSION = var.node_version
  }

  dynamic "env" {
    for_each = var.build_env
    content {
      name  = env.key
      value = env.value
    }
  }
}

# Environment Variables
resource "netlify_site_snippet" "env_vars" {
  for_each = var.secrets

  site_id = netlify_site.main.id
  key     = each.key
  value   = each.value
}

# Custom Headers
resource "netlify_site_snippet" "headers" {
  count = length(var.custom_headers) > 0 ? 1 : 0

  site_id = netlify_site.main.id
  key     = "headers"
  value   = jsonencode(var.custom_headers)
}

# Redirects
resource "netlify_site_snippet" "redirects" {
  count = length(var.redirects) > 0 ? 1 : 0

  site_id = netlify_site.main.id
  key     = "redirects"
  value   = jsonencode(var.redirects)
}
