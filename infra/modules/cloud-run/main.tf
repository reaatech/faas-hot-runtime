terraform {
  required_version = ">= 1.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

# Cloud Run v2 Service
resource "google_cloud_run_v2_service" "main" {
  name     = var.service_name
  location = var.region
  ingress  = var.ingress

  template {
    max_instance_request_concurrency = var.max_instance_request_concurrency
    max_instance_count               = var.max_instance_count
    min_instance_count               = var.min_instance_count

    scaling {
      min_instance_count = var.min_instance_count
      max_instance_count = var.max_instance_count
    }

    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = var.cloudsql_instances
      }
    }

    containers {
      image = var.image_url
      ports {
        name           = "http1"
        container_port = var.container_port
      }

      resources {
        limits = {
          cpu    = var.cpu_limit
          memory = var.memory_limit
        }
      }

      dynamic "env" {
        for_each = var.environment_variables
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = var.secret_environment_variables
        content {
          name = env.value.name
          value_source {
            secret_key_ref {
              secret  = env.value.secret
              version = env.value.version
            }
          }
        }
      }
    }
  }

  dynamic "traffic" {
    for_each = var.traffic_percentages
    content {
      type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
      percent = traffic.value
    }
  }

  labels = var.labels
}

# IAM - Allow unauthenticated invocations
resource "google_cloud_run_service_iam_member" "public" {
  count    = var.allow_unauthenticated ? 1 : 0
  location = google_cloud_run_v2_service.main.location
  name     = google_cloud_run_v2_service.main.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# Service Account for the Cloud Run service
resource "google_service_account" "faas_sa" {
  account_id   = "${var.service_name}-sa"
  display_name = "Service account for faas-hot-runtime"
}

# Grant logging permissions
resource "google_project_iam_member" "logging" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.faas_sa.email}"
}

# Grant metrics permissions
resource "google_project_iam_member" "metrics" {
  project = var.project_id
  role    = "roles/monitoring.metricWriter"
  member  = "serviceAccount:${google_service_account.faas_sa.email}"
}

# Grant trace permissions
resource "google_project_iam_member" "trace" {
  project = var.project_id
  role    = "roles/cloudtrace.agent"
  member  = "serviceAccount:${google_service_account.faas_sa.email}"
}

# Grant secret access if using Secret Manager
resource "google_secret_manager_secret_iam_member" "secret_access" {
  for_each  = var.secret_ids
  project   = var.project_id
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.faas_sa.email}"
}
