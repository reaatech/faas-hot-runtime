variable "cluster_name" {
  description = "Name of the OKE cluster"
  type        = string
}

variable "compartment_id" {
  description = "OCI compartment ID"
  type        = string
}

variable "vcn_id" {
  description = "VCN ID for the cluster"
  type        = string
}

variable "kubernetes_version" {
  description = "Kubernetes version"
  type        = string
}

variable "create_cluster" {
  description = "Whether to create a new cluster"
  type        = bool
  default     = true
}

variable "is_public" {
  description = "Whether the cluster endpoint is public"
  type        = bool
  default     = false
}

variable "cluster_endpoint_subnet_id" {
  description = "Subnet ID for the cluster endpoint"
  type        = string
  default     = null
}

variable "nsg_ids" {
  description = "List of NSG IDs for the cluster endpoint"
  type        = list(string)
  default     = []
}

variable "service_lb_subnet_ids" {
  description = "List of subnet IDs for service load balancers"
  type        = list(string)
  default     = []
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

variable "node_pool_subnet_ids" {
  description = "List of subnet IDs for the node pool"
  type        = list(string)
}

variable "availability_domain" {
  description = "Availability domain for the node pool"
  type        = string
}

variable "ssh_public_key" {
  description = "SSH public key for node access"
  type        = string
  default     = null
}

variable "app_name" {
  description = "Name of the Helm release"
  type        = string
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

variable "replicas" {
  description = "Number of replicas for the deployment"
  type        = number
  default     = 2
}

variable "helm_repository" {
  description = "Helm chart repository URL"
  type        = string
  default     = ""
}

variable "helm_chart" {
  description = "Helm chart name or path"
  type        = string
}

variable "helm_chart_version" {
  description = "Helm chart version"
  type        = string
  default     = ""
}

variable "namespace" {
  description = "Kubernetes namespace for the deployment"
  type        = string
  default     = "default"
}

variable "helm_values" {
  description = "Map of Helm values"
  type        = map(string)
  default     = {}
}
