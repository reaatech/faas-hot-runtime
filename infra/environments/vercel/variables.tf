variable "service_name" {
  description = "Name of the FaaS service"
  type        = string
  default     = "faas-hot-runtime"
}

variable "environment" {
  description = "Environment name (development, staging, production)"
  type        = string
  default     = "development"
}

variable "team_id" {
  description = "Vercel team ID"
  type        = string
  default     = null
}

variable "framework" {
  description = "Framework preset (nextjs, nuxtjs, gatsby, etc.)"
  type        = string
  default     = "nextjs"
}

variable "repo" {
  description = "GitHub repository (owner/repo)"
  type        = string
}

variable "production_branch" {
  description = "Production branch name"
  type        = string
  default     = "main"
}

variable "ref" {
  description = "Git ref to deploy (branch, tag, or commit)"
  type        = string
  default     = "main"
}

variable "domains" {
  description = "List of custom domains"
  type        = list(string)
  default     = []
}

variable "database_url" {
  description = "Database connection URL"
  type        = string
  sensitive   = true
}

variable "redis_url" {
  description = "Redis connection URL"
  type        = string
  sensitive   = true
}

variable "otel_endpoint" {
  description = "OTLP endpoint for observability"
  type        = string
  default     = ""
}

variable "pool_min_size" {
  description = "Minimum size of the warm pool"
  type        = number
  default     = 2
}

variable "pool_max_size" {
  description = "Maximum size of the warm pool"
  type        = number
  default     = 10
}
