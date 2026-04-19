output "cluster_id" {
  description = "OCID of the OKE cluster"
  value       = try(oci_containerengine_cluster.main[0].id, null)
}

output "cluster_name" {
  description = "Name of the OKE cluster"
  value       = try(oci_containerengine_cluster.main[0].name, var.cluster_name)
}

output "cluster_endpoint" {
  description = "Endpoint of the OKE cluster"
  value       = try(oci_containerengine_cluster.main[0].endpoints[0].public_endpoint, null)
}

output "node_pool_id" {
  description = "OCID of the node pool"
  value       = try(oci_containerengine_node_pool.main[0].id, null)
}

output "node_pool_size" {
  description = "Number of nodes in the node pool"
  value       = try(oci_containerengine_node_pool.main[0].node_config_details[0].size, var.node_pool_size)
}

output "helm_release_name" {
  description = "Name of the Helm release"
  value       = helm_release.app.name
}

output "helm_release_status" {
  description = "Status of the Helm release"
  value       = helm_release.app.status
}
