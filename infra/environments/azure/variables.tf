variable "service_name" {
  description = "Name of the FaaS service"
  type        = string
  default     = "faashotruntime"
}

variable "environment" {
  description = "Environment name (development, staging, production)"
  type        = string
  default     = "development"
}

variable "location" {
  description = "Azure region"
  type        = string
  default     = "eastus"
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

variable "db_admin_username" {
  description = "Database admin username"
  type        = string
  default     = "pgadmin"
}

variable "db_admin_password" {
  description = "Database admin password"
  type        = string
  sensitive   = true
}

variable "db_sku_name" {
  description = "PostgreSQL SKU name"
  type        = string
  default     = "GP_Gen5_2"
}

variable "db_version" {
  description = "PostgreSQL version"
  type        = string
  default     = "11"
}

variable "db_storage_mb" {
  description = "Database storage in MB"
  type        = number
  default     = 32768
}

# Redis variables
variable "redis_capacity" {
  description = "Redis cache capacity"
  type        = number
  default     = 1
}

variable "redis_family" {
  description = "Redis SKU family"
  type        = string
  default     = "C"
}

variable "redis_sku_name" {
  description = "Redis SKU name"
  type        = string
  default     = "Basic"
}

variable "redis_maxmemory_reserved" {
  description = "Redis max memory reserved"
  type        = number
  default     = 700
}

variable "redis_maxmemory_delta" {
  description = "Redis max memory delta"
  type        = number
  default     = 600
}

# Container variables
variable "container_cpu" {
  description = "CPU cores for the container"
  type        = number
  default     = 0.5
}

variable "container_memory" {
  description = "Memory in GB for the container"
  type        = number
  default     = 1.0
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
