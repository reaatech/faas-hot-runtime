variable "project_name" {
  description = "Name of the Vercel project"
  type        = string
}

variable "team_id" {
  description = "Vercel team ID"
  type        = string
  default     = null
}

variable "environment" {
  description = "Environment name (development, staging, production)"
  type        = string
  default     = "development"
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

variable "production" {
  description = "Whether this is a production deployment"
  type        = bool
  default     = false
}

variable "path" {
  description = "Path to the project directory"
  type        = string
  default     = ""
}

variable "environment_variables" {
  description = "Map of environment variables"
  type        = map(string)
  default     = {}
}

variable "secrets" {
  description = "Map of secret environment variables"
  type        = map(string)
  default     = {}
}

variable "domains" {
  description = "List of custom domains"
  type        = list(string)
  default     = []
}
