terraform {
  required_version = ">= 1.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
  backend "gcs" {
    bucket = "faas-hot-runtime-tfstate"
    prefix = "gcp/terraform.tfstate"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# Cloud SQL PostgreSQL
resource "google_sql_database_instance" "main" {
  name             = "${var.service_name}-${var.environment}-db"
  database_version = var.db_version
  region           = var.region

  settings {
    tier              = var.db_tier
    availability_type = var.environment == "production" ? "REGIONAL" : "ZONAL"

    backup_configuration {
      enabled                        = true
      start_time                     = "02:00"
      point_in_time_recovery_enabled = var.environment == "production"
      transaction_log_retention_days = var.environment == "production" ? 7 : null
    }

    ip_configuration {
      ipv4_enabled    = true
      require_ssl     = true
      private_network = var.private_network_id
    }

    user_labels = {
      environment = var.environment
      project     = "faas-hot-runtime"
    }
  }

  deletion_protection = var.environment == "production"
}

resource "google_sql_database" "main" {
  name      = var.db_name
  instance  = google_sql_database_instance.main.name
  charset   = "UTF8"
  collation = "en_US.UTF8"
}

resource "google_sql_user" "main" {
  name     = var.db_username
  instance = google_sql_database_instance.main.name
  password = var.db_password
}

# Memorystore Redis
resource "google_redis_instance" "main" {
  name                           = "${var.service_name}-${var.environment}-redis"
  tier                           = var.environment == "production" ? "STANDARD_HA" : "BASIC"
  memory_size_gb                 = var.redis_memory_size_gb
  region                         = var.region
  authorized_network             = var.private_network_id
  display_name                   = "${var.service_name} Redis"
  redis_version                  = var.redis_version
  reserved_ip_range              = var.redis_reserved_ip_range
  replicas                       = var.environment == "production" ? 1 : 0
  transit_encryption_mode        = "SERVER_AUTHENTICATION"
  read_replicas_mode             = var.environment == "production" ? "READ_REPLICAS_ENABLED" : "READ_REPLICAS_DISABLED"

  redis_config {
    maxmemory_policy = var.redis_maxmemory_policy
  }

  labels = {
    environment = var.environment
    project     = "faas-hot-runtime"
  }
}

# Cloud Storage bucket for function artifacts
resource "google_storage_bucket" "main" {
  name          = "${var.service_name}-${var.environment}-storage-${var.project_id}"
  location      = var.region
  force_destroy = var.environment != "production"

  uniform_bucket_level_access = true

  versioning {
    enabled = true
  }

  lifecycle_rule {
    condition {
      age = 90
    }
    action {
      type = "Delete"
    }
  }

  labels = {
    environment = var.environment
    project     = "faas-hot-runtime"
  }
}

# Secret Manager for database credentials
resource "google_secret_manager_secret" "db_credentials" {
  secret_id = "${var.service_name}-${var.environment}-db-credentials"

  replication {
    auto {}
  }

  labels = {
    environment = var.environment
  }
}

resource "google_secret_manager_secret_version" "db_credentials" {
  secret = google_secret_manager_secret.db_credentials.id

  secret_data = jsonencode({
    username = var.db_username
    password = var.db_password
  })
}

# Cloud Run Module
module "cloud_run" {
  source = "../../modules/cloud-run"

  service_name = var.service_name
  project_id   = var.project_id
  region       = var.region
  image_url    = var.image_url

  min_instance_count = var.environment == "production" ? 2 : 0
  max_instance_count = var.environment == "production" ? 100 : 10

  allow_unauthenticated = true

  environment_variables = {
    NODE_ENV         = var.environment
    LOG_LEVEL        = var.environment == "production" ? "info" : "debug"
    DATABASE_URL     = "postgres://${var.db_username}:${var.db_password}@${google_sql_database_instance.main.private_ip_address}:5432/${var.db_name}"
    REDIS_URL        = "redis://${google_redis_instance.main.host}:${google_redis_instance.main.port}"
    S3_BUCKET        = google_storage_bucket.main.name
    OTEL_EXPORTER    = "otlp"
    OTEL_ENDPOINT    = var.otel_endpoint
    MCP_TRANSPORT    = "http"
    POOL_MIN_SIZE    = var.pool_min_size
    POOL_MAX_SIZE    = var.pool_max_size
  }

  secret_environment_variables = {
    DB_PASSWORD = {
      name    = "DB_PASSWORD"
      secret  = google_secret_manager_secret.db_credentials.secret_id
      version = "latest"
    }
  }

  secret_ids = {
    DB_CREDENTIALS = google_secret_manager_secret.db_credentials.secret_id
  }

  cloudsql_instances = ["${var.project_id}:${var.region}:${google_sql_database_instance.main.connection_name}"]

  labels = {
    environment = var.environment
    project     = "faas-hot-runtime"
  }
}
