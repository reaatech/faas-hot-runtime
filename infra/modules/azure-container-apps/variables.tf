variable "app_name" {
  description = "Name of the FaaS application"
  type        = string
}

variable "location" {
  description = "Azure region"
  type        = string
}

variable "image_url" {
  description = "Docker image URL for the FaaS runtime"
  type        = string
}

variable "container_port" {
  description = "Port the container listens on"
  type        = number
  default     = 8080
}

variable "environment" {
  description = "Environment name (development, staging, production)"
  type        = string
  default     = "development"
}

variable "environment_variables" {
  description = "Map of environment variables to pass to the container"
  type        = map(string)
  default     = {}
}

variable "secrets" {
  description = "Map of secret names to Key Vault secret IDs"
  type        = map(any)
  default     = {}
}

variable "cpu" {
  description = "CPU cores for the container (0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0)"
  type        = number
  default     = 0.5
}

variable "memory" {
  description = "Memory in GB for the container (0.5, 1.0, 1.5, 2.0, 3.0, 4.0)"
  type        = number
  default     = 1.0
}

variable "min_replicas" {
  description = "Minimum number of replicas"
  type        = number
  default     = 0
}

variable "max_replicas" {
  description = "Maximum number of replicas"
  type        = number
  default     = 10
}

variable "create_resource_group" {
  description = "Whether to create a new resource group"
  type        = bool
  default     = true
}

variable "resource_group_name" {
  description = "Name of the resource group (used if create_resource_group = true)"
  type        = string
  default     = null
}

variable "existing_resource_group_name" {
  description = "Name of an existing resource group (used if create_resource_group = false)"
  type        = string
  default     = null
}

variable "subnet_id" {
  description = "ID of the subnet for the Container Apps environment"
  type        = string
  default     = null
}

variable "tags" {
  description = "Map of tags to apply to all resources"
  type        = map(string)
  default     = {}
}
