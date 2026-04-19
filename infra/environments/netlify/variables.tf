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

variable "account_slug" {
  description = "Netlify account slug"
  type        = string
}

variable "custom_domain" {
  description = "Custom domain for the site"
  type        = string
  default     = null
}

variable "build_dir" {
  description = "Build directory for the site"
  type        = string
  default     = ""
}

variable "node_version" {
  description = "Node.js version"
  type        = string
  default     = "22"
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
