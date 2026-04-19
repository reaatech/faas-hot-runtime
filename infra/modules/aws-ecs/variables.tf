variable "service_name" {
  description = "Name of the FaaS service"
  type        = string
}

variable "region" {
  description = "AWS region"
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

variable "cpu" {
  description = "CPU units for the task (256, 512, 1024, 2048, 4096)"
  type        = number
  default     = 512
}

variable "memory" {
  description = "Memory in MB for the task (512, 1024, 2048, 3072, 4096, etc.)"
  type        = number
  default     = 1024
}

variable "desired_count" {
  description = "Desired number of running tasks"
  type        = number
  default     = 1
}

variable "environment_variables" {
  description = "Map of environment variables to pass to the container"
  type        = map(string)
  default     = {}
}

variable "secrets" {
  description = "Map of secret names to AWS Secrets Manager ARNs or SSM parameters"
  type        = map(string)
  default     = {}
}

variable "subnet_ids" {
  description = "List of subnet IDs for the service"
  type        = list(string)
}

variable "security_group_ids" {
  description = "List of security group IDs for the service"
  type        = list(string)
}

variable "target_group_arn" {
  description = "ARN of the load balancer target group"
  type        = string
  default     = null
}

variable "assign_public_ip" {
  description = "Whether to assign a public IP to the tasks"
  type        = bool
  default     = false
}

variable "create_cluster" {
  description = "Whether to create a new ECS cluster"
  type        = bool
  default     = true
}

variable "cluster_arn" {
  description = "ARN of an existing ECS cluster (used when create_cluster = false)"
  type        = string
  default     = null
}

variable "enable_container_insights" {
  description = "Whether to enable CloudWatch Container Insights"
  type        = bool
  default     = true
}

variable "log_retention_days" {
  description = "Number of days to retain CloudWatch logs"
  type        = number
  default     = 30
}

variable "enable_health_check" {
  description = "Whether to enable health checks on the container"
  type        = bool
  default     = true
}

variable "enable_autoscaling" {
  description = "Whether to enable auto-scaling"
  type        = bool
  default     = true
}

variable "min_capacity" {
  description = "Minimum number of tasks for auto-scaling"
  type        = number
  default     = 1
}

variable "max_capacity" {
  description = "Maximum number of tasks for auto-scaling"
  type        = number
  default     = 10
}

variable "cpu_target_value" {
  description = "Target CPU utilization percentage for auto-scaling"
  type        = number
  default     = 70
}

variable "memory_target_value" {
  description = "Target memory utilization percentage for auto-scaling"
  type        = number
  default     = 70
}

variable "enable_service_connect" {
  description = "Whether to enable ECS Service Connect"
  type        = bool
  default     = false
}

variable "service_connect_namespace" {
  description = "Service Connect namespace ARN"
  type        = string
  default     = null
}

variable "enable_resource_requirements" {
  description = "Whether to specify resource requirements (e.g., GPU)"
  type        = bool
  default     = false
}

variable "gpu_count" {
  description = "Number of GPUs to allocate (if enable_resource_requirements = true)"
  type        = number
  default     = 0
}

variable "cpu_architecture" {
  description = "CPU architecture (X86_64 or ARM64)"
  type        = string
  default     = "X86_64"
}

variable "tags" {
  description = "Map of tags to apply to all resources"
  type        = map(string)
  default     = {}
}
