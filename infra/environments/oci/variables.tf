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

variable "region" {
  description = "OCI region"
  type        = string
  default     = "us-phoenix-1"
}

variable "image_url" {
  description = "Docker image URL for the FaaS runtime"
  type        = string
}

variable "image_tag" {
  description = "Docker image tag"
  type        = string
  default     = "latest"
}

# OCI Authentication
variable "tenancy_ocid" {
  description = "OCI tenancy OCID"
  type        = string
}

variable "user_ocid" {
  description = "OCI user OCID"
  type        = string
}

variable "fingerprint" {
  description = "API signing key fingerprint"
  type        = string
}

variable "private_key_path" {
  description = "Path to the API signing private key"
  type        = string
}

variable "compartment_id" {
  description = "OCI compartment ID"
  type        = string
}

# Network variables
variable "vcn_cidr" {
  description = "CIDR block for the VCN"
  type        = string
  default     = "10.0.0.0/16"
}

variable "public_subnet_cidr" {
  description = "CIDR block for the public subnet"
  type        = string
  default     = "10.0.0.0/24"
}

variable "private_subnet_cidr" {
  description = "CIDR block for the private subnet"
  type        = string
  default     = "10.0.1.0/24"
}

# OKE variables
variable "kubernetes_version" {
  description = "Kubernetes version for OKE"
  type        = string
  default     = "v1.28.0"
}

variable "node_shape" {
  description = "Shape of the node instances"
  type        = string
  default     = "VM.Standard.E4.Flex"
}

variable "node_memory_in_gbs" {
  description = "Memory in GB for node instances"
  type        = number
  default     = 16
}

variable "node_ocpus" {
  description = "Number of OCPUs for node instances"
  type        = number
  default     = 2
}

variable "node_image_id" {
  description = "Image ID for node instances"
  type        = string
}

variable "node_pool_size" {
  description = "Number of nodes in the node pool"
  type        = number
  default     = 3
}

variable "availability_domain" {
  description = "Availability domain for the node pool"
  type        = string
}

variable "helm_chart" {
  description = "Helm chart name or path for deploying the FaaS runtime"
  type        = string
  default     = "faas-hot-runtime"
}

variable "replicas" {
  description = "Number of replicas for the deployment"
  type        = number
  default     = 2
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
