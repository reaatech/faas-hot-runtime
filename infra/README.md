# Infrastructure

This directory contains Terraform configurations for deploying faas-hot-runtime to various cloud providers.

## Directory Structure

```
infra/
├── modules/                    # Reusable Terraform modules
│   ├── aws-ecs/               # AWS EKS/ECS for FaaS runtime
│   ├── azure-container-apps/  # Azure Container Apps/AKS
│   ├── cloud-run/             # GCP Cloud Run/GKE
│   ├── oci-oke/               # Oracle Container Engine (OKE)
│   ├── netlify/               # Netlify serverless deployment
│   └── vercel/                # Vercel serverless deployment
└── environments/              # Environment-specific configurations
    ├── aws/                   # AWS deployment
    ├── azure/                 # Azure deployment
    ├── gcp/                   # GCP deployment
    ├── oci/                   # Oracle Cloud deployment
    ├── netlify/               # Netlify deployment
    └── vercel/                # Vercel deployment
```

## Supported Platforms

| Platform | Compute | Database | Cache | Storage | Status |
|----------|---------|----------|-------|---------|--------|
| **AWS** | EKS/ECS Fargate | RDS PostgreSQL | ElastiCache Redis | S3 | ✅ Complete |
| **Azure** | AKS/Container Apps | PostgreSQL | Redis Cache | Blob Storage | ✅ Complete |
| **GCP** | GKE/Cloud Run | Cloud SQL | Memorystore | Cloud Storage | ✅ Complete |
| **OCI** | OKE (Kubernetes) | Autonomous DB | Redis | Object Storage | ✅ Complete |
| **Netlify** | Serverless Functions | External | External | External | ✅ Complete |
| **Vercel** | Serverless Functions | External | External | External | ✅ Complete |

---

## AWS Deployment

### Prerequisites

- AWS CLI configured with appropriate credentials
- Terraform >= 1.0
- A VPC with private and public subnets (or let Terraform create one)
- Docker image built and pushed to ECR or public registry

### Quick Start

1. Navigate to the AWS environment:
   ```bash
   cd environments/aws
   ```

2. Copy and configure the terraform.tfvars file:
   ```bash
   cp terraform.tfvars.example terraform.tfvars
   # Edit terraform.tfvars with your values
   ```

3. Required variables:
   - `vpc_id` - ID of your VPC (or set `create_vpc = true`)
   - `image_url` - Docker image URL for the FaaS runtime
   - `db_password` - Secure password for the database

4. Initialize and deploy:
   ```bash
   terraform init
   terraform plan
   terraform apply
   ```

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                           VPC                                │
│  ┌─────────────────────────────────────────────────────┐    │
│  │                   Private Subnets                     │    │
│  │  ┌───────────┐  ┌───────────┐  ┌───────────┐        │    │
│  │  │    RDS    │  │   Redis   │  │  EKS/ECS  │        │    │
│  │  │ PostgreSQL│  │ElastiCache│  │  Fargate  │        │    │
│  │  └───────────┘  └───────────┘  │   (Warm   │        │    │
│  │                                  │   Pool)  │        │    │
│  │  ┌───────────┐                  │           │        │    │
│  │  │    S3     │◄─────────────────┘           │        │    │
│  │  └───────────┘                               │        │    │
│  └──────────────────────────────────────────────┼────────┘    │
│  ┌──────────────────────────────────────────────┼────────┐    │
│  │              ALB/API Gateway                 │        │    │
│  └──────────────────────────────────────────────┼────────┘    │
│                                   ┌─────────────┘             │
│  ┌────────────────────────────────┘                            │
│  │              Secrets Manager                                │
│  └─────────────────────────────────────────────────────────────┘
└─────────────────────────────────────────────────────────────┘
```

### Components

- **EKS Cluster** or **ECS Fargate** for running the FaaS runtime
- **RDS PostgreSQL** for function state and registry persistence
- **ElastiCache Redis** for warm pool optimization
- **S3** for function artifacts and logs
- **ALB** for HTTP trigger routing
- **Secrets Manager** for sensitive configuration

---

## Azure Deployment

### Prerequisites

- Azure CLI configured with appropriate credentials
- Terraform >= 1.0
- Docker image pushed to Azure Container Registry

### Quick Start

1. Navigate to the Azure environment:
   ```bash
   cd environments/azure
   ```

2. Configure terraform.tfvars:
   - `resource_group_name` - Name of resource group (or set `create_resource_group = true`)
   - `location` - Azure region
   - `image_url` - ACR image URL
   - `db_admin_username` - PostgreSQL admin
   - `db_admin_password` - PostgreSQL password

3. Initialize and deploy:
   ```bash
   terraform init
   terraform plan
   terraform apply
   ```

### Architecture

- **Compute**: AKS or Azure Container Apps with auto-scaling
- **Database**: Azure Database for PostgreSQL
- **Cache**: Azure Cache for Redis
- **Storage**: Azure Blob Storage
- **Monitoring**: Application Insights + Log Analytics

---

## GCP Deployment

### Prerequisites

- GCP CLI (gcloud) configured
- Terraform >= 1.0
- Docker image pushed to GCR or Artifact Registry

### Quick Start

1. Navigate to the GCP environment:
   ```bash
   cd environments/gcp
   ```

2. Configure terraform.tfvars:
   - `project_id` - GCP project ID
   - `region` - GCP region
   - `image_url` - Container image URL

3. Initialize and deploy:
   ```bash
   terraform init
   terraform plan
   terraform apply
   ```

### Architecture

- **Compute**: GKE or Cloud Run (serverless containers)
- **Secrets**: Secret Manager
- **Database**: Cloud SQL for PostgreSQL
- **Cache**: Memorystore for Redis
- **Storage**: Cloud Storage
- **Monitoring**: Cloud Monitoring + Cloud Trace

---

## OCI Deployment

### Prerequisites

- OCI CLI configured with API signing keys
- Terraform >= 1.0
- Docker image pushed to OCI Registry

### Quick Start

1. Navigate to the OCI environment:
   ```bash
   cd environments/oci
   ```

2. Configure terraform.tfvars:
   - `compartment_id` - OCI compartment
   - `region` - OCI region
   - `tenancy_ocid`, `user_ocid`, `fingerprint` - API credentials
   - `image_url` - Container image URL

3. Initialize and deploy:
   ```bash
   terraform init
   terraform plan
   terraform apply
   ```

### Architecture

- **Compute**: Oracle Container Engine for Kubernetes (OKE)
- **Network**: VCN with public/private subnets
- **Database**: Autonomous Transaction Processing
- **Cache**: Redis Cloud
- **Storage**: Object Storage
- **Monitoring**: OCI Monitoring + Logging

---

## Netlify Deployment

### Prerequisites

- Netlify account with API token
- Terraform >= 1.0
- Build artifacts for the FaaS runtime

### Quick Start

1. Navigate to the Netlify environment:
   ```bash
   cd environments/netlify
   ```

2. Configure terraform.tfvars:
   - `netlify_token` - Netlify API token
   - `site_name` - Site name
   - `account_slug` - Account slug
   - `database_url` - External database connection string

3. Initialize and deploy:
   ```bash
   terraform init
   terraform plan
   terraform apply
   ```

### Features

- Netlify Functions for serverless compute
- Automatic HTTPS
- CDN distribution
- Environment variables for configuration
- Custom headers and redirects

---

## Vercel Deployment

### Prerequisites

- Vercel account with API token
- Terraform >= 1.0
- GitHub repository connected to Vercel

### Quick Start

1. Navigate to the Vercel environment:
   ```bash
   cd environments/vercel
   ```

2. Configure terraform.tfvars:
   - `vercel_token` - Vercel API token
   - `project_name` - Project name
   - `repo` - GitHub repository (owner/repo)
   - `database_url` - External database connection string

3. Initialize and deploy:
   ```bash
   terraform init
   terraform plan
   terraform apply
   ```

### Features

- Vercel Serverless Functions
- Edge functions for low-latency invocations
- Automatic preview deployments for PRs
- Custom domains
- Analytics integration

---

## Development

### Running Locally

For local development, use Docker Compose:

```bash
cd ../..  # Project root
docker-compose up
```

### Module Development

When creating new modules:

1. Create directory: `modules/<provider>-<service>/`
2. Add `main.tf`, `variables.tf`, `outputs.tf`
3. Follow naming conventions
4. Document all variables and outputs

### Testing Changes

1. Run `terraform fmt -recursive` to format all files
2. Run `terraform validate` in each environment
3. Run `terraform plan` to preview changes
4. Test in dev environment first

---

## Troubleshooting

### Common Issues

1. **VPC Subnet Discovery (AWS)**: Ensure your VPC has subnets tagged appropriately
2. **Image Pull Errors**: Verify the image URL is accessible from your account
3. **Database Connection**: Check security group rules and network connectivity
4. **Permissions**: Ensure your credentials have sufficient permissions
5. **Warm Pool Initialization**: Allow time for the warm pool to initialize before testing

### Getting Help

- Check the specific environment's README for detailed documentation
- Review the module's variables.tf for configuration options
- Check CloudWatch/Cloud Monitoring logs for runtime issues
- See the main project's [AGENTS.md](../AGENTS.md) for FaaS-specific guidance
