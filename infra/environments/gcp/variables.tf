variable "service_name" {
  description = "Name of the FaaS service"
  type        = string
  default     = "faas-hot-runtime"
}

variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "region" {
  description = "GCP region"
  type        = string
  default     = "us-central1"
}

variable "environment" {
  description = "Environment name (development, staging, production)"
  type        = string
  default     = "development"
}

variable "image_url" {
  description = "Docker image URL for the FaaS runtime"
  type        = string
}

# Database variables
variable "db_name" {
  description = "Name of the database"
  type        = string
  default     = "faas_hot_runtime"
}

variable "db_username" {
  description = "Database username"
  type        = string
  default     = "admin"
}

variable "db_password" {
  description = "Database password"
  type        = string
  sensitive   = true
}

variable "db_version" {
  description = "PostgreSQL version"
  type        = string
  default     = "POSTGRES_15"
}

variable "db_tier" {
  description = "Database machine type"
  type        = string
  default     = "db-f1-micro"
}

variable "private_network_id" {
  description = "ID of the VPC for private IP"
  type        = string
  default     = null
}

# Redis variables
variable "redis_memory_size_gb" {
  description = "Redis memory size in GB"
  type        = number
  default     = 1
}

variable "redis_version" {
  description = "Redis version"
  type        = string
  default     = "REDIS_7_0"
}

variable "redis_reserved_ip_range" {
  description = "Reserved IP range for Redis"
  type        = string
  default     = null
}

variable "redis_maxmemory_policy" {
  description = "Redis maxmemory policy"
  type        = string
  default     = "volatile-lru"
}

# Warm Pool variables
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

# Observability variables
variable "otel_endpoint" {
  description = "OTLP endpoint for observability"
  type        = string
  default     = ""
}
