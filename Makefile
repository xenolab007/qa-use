SHELL := /bin/bash

# ─── Variables ────────────────────────────────────────────────────────────────
IMAGE_NAME      := qa-use
PROD_ACCOUNT    := 025778817848
DEV_ACCOUNT     := 315221066430
AWS_REGION      := ap-south-1
PROD_REPO       := $(PROD_ACCOUNT).dkr.ecr.$(AWS_REGION).amazonaws.com
DEV_REPO        := $(DEV_ACCOUNT).dkr.ecr.$(AWS_REGION).amazonaws.com
GIT_TAG         := $(shell git rev-parse --short HEAD)
NAMESPACE       := qa-use
HELM_CHART_DIR  := ./helm
K8S_REPO        := xeno-k8s-deployments

# ─── Help ─────────────────────────────────────────────────────────────────────
.PHONY: help
help:
	@echo "qa-use Makefile"
	@echo ""
	@echo "Local development:"
	@echo "  make dev            Start dev server with hot-reload (docker-compose)"
	@echo "  make up             Start production docker-compose stack"
	@echo "  make down           Stop all containers"
	@echo "  make logs           Tail app container logs"
	@echo "  make migrate        Run database migrations"
	@echo ""
	@echo "Docker / ECR (prod):"
	@echo "  make login-prod     Login to prod ECR"
	@echo "  make build          Build Docker image (tagged with git SHA)"
	@echo "  make push-prod      Push image to prod ECR"
	@echo ""
	@echo "Docker / ECR (dev):"
	@echo "  make login-dev      Login to dev ECR"
	@echo "  make push-dev       Push image to dev ECR"
	@echo ""
	@echo "Helm:"
	@echo "  make deploy-prod    helm upgrade --install against prod values"
	@echo "  make deploy-dev     helm upgrade --install against dev values"
	@echo "  make diff-prod      helm diff against prod values"
	@echo "  make diff-dev       helm diff against dev values"

# ─── Local Development ────────────────────────────────────────────────────────
.PHONY: dev
dev:
	docker compose -f docker-compose.dev.yaml up --build

.PHONY: up
up:
	docker compose up --build -d

.PHONY: down
down:
	docker compose down

.PHONY: logs
logs:
	docker compose logs -f app

.PHONY: migrate
migrate:
	docker compose run --rm migrate

# ─── ECR Login ────────────────────────────────────────────────────────────────
.PHONY: login-prod
login-prod:
	aws ecr get-login-password --region $(AWS_REGION) | \
		docker login -u AWS --password-stdin $(PROD_REPO)

.PHONY: login-dev
login-dev:
	aws ecr get-login-password --region $(AWS_REGION) | \
		docker login -u AWS --password-stdin $(DEV_REPO)

# ─── Build ────────────────────────────────────────────────────────────────────
.PHONY: build
build:
	DOCKER_BUILDKIT=1 docker build -t $(IMAGE_NAME):$(GIT_TAG) .
	@echo "Built $(IMAGE_NAME):$(GIT_TAG)"

# ─── Push to Prod ECR ─────────────────────────────────────────────────────────
.PHONY: push-prod
push-prod: build login-prod
	docker tag $(IMAGE_NAME):$(GIT_TAG) $(PROD_REPO)/$(IMAGE_NAME):$(GIT_TAG)
	docker push $(PROD_REPO)/$(IMAGE_NAME):$(GIT_TAG)
	@echo "Pushed $(PROD_REPO)/$(IMAGE_NAME):$(GIT_TAG)"

# ─── Push to Dev ECR ──────────────────────────────────────────────────────────
.PHONY: push-dev
push-dev: build login-dev
	docker tag $(IMAGE_NAME):$(GIT_TAG) $(DEV_REPO)/$(IMAGE_NAME):$(GIT_TAG)
	docker push $(DEV_REPO)/$(IMAGE_NAME):$(GIT_TAG)
	@echo "Pushed $(DEV_REPO)/$(IMAGE_NAME):$(GIT_TAG)"

# ─── Helm Deploy ──────────────────────────────────────────────────────────────
.PHONY: deploy-prod
deploy-prod:
	helm upgrade --install $(IMAGE_NAME) $(HELM_CHART_DIR) \
		-f $(HELM_CHART_DIR)/values/prod.yaml \
		--namespace $(NAMESPACE) \
		--create-namespace \
		--set image.repository=$(PROD_REPO)/$(IMAGE_NAME) \
		--set image.tag=$(GIT_TAG) \
		--wait

.PHONY: deploy-dev
deploy-dev:
	helm upgrade --install $(IMAGE_NAME) $(HELM_CHART_DIR) \
		-f $(HELM_CHART_DIR)/values/dev.yaml \
		--namespace $(NAMESPACE) \
		--create-namespace \
		--set image.repository=$(DEV_REPO)/$(IMAGE_NAME) \
		--set image.tag=$(GIT_TAG) \
		--wait

# ─── Helm Diff (requires helm-diff plugin) ────────────────────────────────────
.PHONY: diff-prod
diff-prod:
	helm diff upgrade $(IMAGE_NAME) $(HELM_CHART_DIR) \
		-f $(HELM_CHART_DIR)/values/prod.yaml \
		--namespace $(NAMESPACE) \
		--set image.repository=$(PROD_REPO)/$(IMAGE_NAME) \
		--set image.tag=$(GIT_TAG)

.PHONY: diff-dev
diff-dev:
	helm diff upgrade $(IMAGE_NAME) $(HELM_CHART_DIR) \
		-f $(HELM_CHART_DIR)/values/dev.yaml \
		--namespace $(NAMESPACE) \
		--set image.repository=$(DEV_REPO)/$(IMAGE_NAME) \
		--set image.tag=$(GIT_TAG)
