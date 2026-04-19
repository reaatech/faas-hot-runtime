output "vcn_id" {
  description = "OCID of the VCN"
  value       = oci_core_vcn.main.id
}

output "cluster_id" {
  description = "OCID of the OKE cluster"
  value       = module.oke.cluster_id
}

output "cluster_endpoint" {
  description = "Endpoint of the OKE cluster"
  value       = module.oke.cluster_endpoint
}

output "node_pool_id" {
  description = "OCID of the node pool"
  value       = module.oke.node_pool_id
}

output "public_subnet_id" {
  description = "OCID of the public subnet"
  value       = oci_core_subnet.public.id
}

output "private_subnet_id" {
  description = "OCID of the private subnet"
  value       = oci_core_subnet.private.id
}

output "helm_release_status" {
  description = "Status of the Helm release"
  value       = module.oke.helm_release_status
}
