variable "service_name" {
  description = "Name of the FaaS service"
  type        = string
}

variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "region" {
  description = "GCP region"
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

variable "ingress" {
  description = "Ingress settings (all, internal, internal-and-cloud-load-balancing)"
  type        = string
  default     = "all"
}

variable "allow_unauthenticated" {
  description = "Whether to allow unauthenticated invocations"
  type        = bool
  default     = true
}

variable "min_instance_count" {
  description = "Minimum number of instances (0 for scale to zero)"
  type        = number
  default     = 0
}

variable "max_instance_count" {
  description = "Maximum number of instances"
  type        = number
  default     = 100
}

variable "max_instance_request_concurrency" {
  description = "Maximum concurrent requests per instance"
  type        = number
  default     = 80
}

variable "cpu_limit" {
  description = "CPU limit (e.g., '1000m' for 1 CPU)"
  type        = string
  default     = "1000m"
}

variable "memory_limit" {
  description = "Memory limit (e.g., '512Mi', '1Gi')"
  type        = string
  default     = "512Mi"
}

variable "environment_variables" {
  description = "Map of environment variables"
  type        = map(string)
  default     = {}
}

variable "secret_environment_variables" {
  description = "Map of secret environment variables with secret references"
  type        = map(any)
  default     = {}
}

variable "secret_ids" {
  description = "Map of secret names to secret IDs in Secret Manager"
  type        = map(string)
  default     = {}
}

variable "traffic_percentages" {
  description = "List of traffic percentages for revisions"
  type        = list(number)
  default     = [100]
}

variable "cloudsql_instances" {
  description = "List of Cloud SQL instance connection names"
  type        = list(string)
  default     = []
}

variable "labels" {
  description = "Map of labels to apply to the service"
  type        = map(string)
  default     = {}
}
