terraform {
  required_version = ">= 1.0"
  required_providers {
    vercel = {
      source  = "vercel/vercel"
      version = "~> 1.0"
    }
  }
}

# Vercel Project
resource "vercel_project" "main" {
  name      = var.project_name
  framework = var.framework
  team_id   = var.team_id

  environment = [
    {
      key    = "NODE_ENV"
      value  = var.environment
      target = ["production", "preview", "development"]
    }
  ]

  dynamic "environment" {
    for_each = var.environment_variables
    content {
      key    = environment.key
      value  = environment.value
      target = ["production", "preview", "development"]
    }
  }

  git_repository {
    type = "github"
    repo = var.repo
    production_branch = var.production_branch
  }
}

# Environment Variables (Secrets)
resource "vercel_project_environment_variable" "secrets" {
  for_each = var.secrets

  project_id = vercel_project.main.id
  team_id    = var.team_id
  key        = each.key
  value      = each.value
  target     = ["production", "preview", "development"]
}

# Vercel Deployment
resource "vercel_deployment" "main" {
  project_id = vercel_project.main.id
  team_id    = var.team_id
  ref        = var.ref
  production = var.production
  path       = var.path
}

# Project Domains
resource "vercel_project_domain" "main" {
  count = length(var.domains)

  project_id = vercel_project.main.id
  team_id    = var.team_id
  domain     = var.domains[count.index]
}
