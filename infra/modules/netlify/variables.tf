variable "site_name" {
  description = "Name of the Netlify site"
  type        = string
}

variable "account_slug" {
  description = "Netlify account slug"
  type        = string
}

variable "environment" {
  description = "Environment name (development, staging, production)"
  type        = string
  default     = "development"
}

variable "custom_domain" {
  description = "Custom domain for the site"
  type        = string
  default     = null
}

variable "force_ssl" {
  description = "Force HTTPS for the site"
  type        = bool
  default     = true
}

variable "css_bundle" {
  description = "Bundle CSS files"
  type        = bool
  default     = false
}

variable "css_minify" {
  description = "Minify CSS files"
  type        = bool
  default     = true
}

variable "js_bundle" {
  description = "Bundle JavaScript files"
  type        = bool
  default     = false
}

variable "js_minify" {
  description = "Minify JavaScript files"
  type        = bool
  default     = true
}

variable "pretty_urls" {
  description = "Enable pretty URLs"
  type        = bool
  default     = true
}

variable "image_compress" {
  description = "Compress images"
  type        = bool
  default     = true
}

variable "build_dir" {
  description = "Build directory for the site"
  type        = string
  default     = ""
}

variable "functions_dir" {
  description = "Directory for Netlify Functions"
  type        = string
  default     = "netlify/functions"
}

variable "node_version" {
  description = "Node.js version"
  type        = string
  default     = "22"
}

variable "build_env" {
  description = "Map of build environment variables"
  type        = map(string)
  default     = {}
}

variable "secrets" {
  description = "Map of secret environment variables"
  type        = map(string)
  default     = {}
}

variable "custom_headers" {
  description = "Map of custom headers"
  type        = map(string)
  default     = {}
}

variable "redirects" {
  description = "List of redirect rules"
  type        = list(any)
  default     = []
}
