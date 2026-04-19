terraform {
  required_version = ">= 1.0"
  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "~> 5.0"
    }
  }
}

provider "oci" {
  region               = var.region
  tenancy_ocid         = var.tenancy_ocid
  user_ocid            = var.user_ocid
  fingerprint          = var.fingerprint
  private_key_path     = var.private_key_path
}

# VCN
resource "oci_core_vcn" "main" {
  compartment_id = var.compartment_id
  display_name   = "${var.service_name}-vcn"
  dns_label      = "faashot"
  cidr_blocks    = [var.vcn_cidr]
}

# Internet Gateway
resource "oci_core_internet_gateway" "main" {
  compartment_id = var.compartment_id
  display_name   = "${var.service_name}-igw"
  vcn_id         = oci_core_vcn.main.id
}

# Public Subnet
resource "oci_core_subnet" "public" {
  compartment_id  = var.compartment_id
  display_name    = "${var.service_name}-public-subnet"
  vcn_id          = oci_core_vcn.main.id
  cidr_block      = var.public_subnet_cidr
  dns_label       = "public"
  route_table_id  = oci_core_vcn.main.default_route_table_id
  security_list_ids = [oci_core_vcn.main.default_security_list_id]
}

# Private Subnet
resource "oci_core_subnet" "private" {
  compartment_id  = var.compartment_id
  display_name    = "${var.service_name}-private-subnet"
  vcn_id          = oci_core_vcn.main.id
  cidr_block      = var.private_subnet_cidr
  dns_label       = "private"
  route_table_id  = oci_core_route_table.private.id
  security_list_ids = [oci_core_security_list.private.id]
}

# Route Table for Private Subnet (NAT Gateway)
resource "oci_core_nat_gateway" "main" {
  compartment_id = var.compartment_id
  display_name   = "${var.service_name}-nat-gw"
  vcn_id         = oci_core_vcn.main.id
}

resource "oci_core_route_table" "private" {
  compartment_id = var.compartment_id
  display_name   = "${var.service_name}-private-rt"
  vcn_id         = oci_core_vcn.main.id

  route_rules {
    description       = "Traffic to the internet"
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
    network_entity_id = oci_core_nat_gateway.main.id
  }
}

# Security List for Private Subnet
resource "oci_core_security_list" "private" {
  compartment_id = var.compartment_id
  display_name   = "${var.service_name}-private-sl"
  vcn_id         = oci_core_vcn.main.id

  egress_security_rules {
    destination = "0.0.0.0/0"
    protocol    = "all"
  }

  ingress_security_rules {
    source    = var.vcn_cidr
    protocol  = "6"  # TCP
    tcp_options {
      min = 6443
      max = 6443
    }
  }

  ingress_security_rules {
    source    = var.vcn_cidr
    protocol  = "6"  # TCP
    tcp_options {
      min = 8080
      max = 8080
    }
  }
}

# OKE Module
module "oke" {
  source = "../../modules/oci-oke"

  cluster_name        = "${var.service_name}-cluster"
  compartment_id      = var.compartment_id
  vcn_id              = oci_core_vcn.main.id
  kubernetes_version  = var.kubernetes_version

  is_public                    = false
  cluster_endpoint_subnet_id   = oci_core_subnet.private.id
  service_lb_subnet_ids        = [oci_core_subnet.public.id]

  node_shape           = var.node_shape
  node_memory_in_gbs   = var.node_memory_in_gbs
  node_ocpus           = var.node_ocpus
  node_image_id        = var.node_image_id
  node_pool_size       = var.node_pool_size
  node_pool_subnet_ids = [oci_core_subnet.private.id]
  availability_domain  = var.availability_domain

  app_name    = var.service_name
  image_url   = var.image_url
  image_tag   = var.image_tag
  replicas    = var.replicas
  helm_chart  = var.helm_chart

  helm_values = {
    nodeEnv         = var.environment
    logLevel        = var.environment == "production" ? "info" : "debug"
    poolMinSize     = var.pool_min_size
    poolMaxSize     = var.pool_max_size
    otelExporter    = "otlp"
    otelEndpoint    = var.otel_endpoint
    mcpTransport    = "http"
  }
}
