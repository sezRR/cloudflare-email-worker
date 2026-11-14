# Run these on the VPS, from the repo checkout. Plain `make` lists the commands.
#
# The schedule comes from CRON_SCHEDULE in .env (hourly if unset). A value on the command line
# wins:  make cron-set SCHEDULE='*/15 * * * *'

# Only this one key is read out of .env. Including the whole file would make `make` interpret
# any "$" or "#" in the secrets. Surrounding quotes are dropped.
ENV_SCHEDULE := $(shell sed -n 's/^CRON_SCHEDULE=//p' .env 2>/dev/null | tail -1 | tr -d "\"'")

SCHEDULE ?= $(or $(ENV_SCHEDULE),0 * * * *)
LOG      ?= /var/log/email-labeller.log

# Marks our line in the crontab so cron-set can replace it instead of adding a duplicate.
TAG := email-labeller-cron

# The trailing "# TAG" is a shell comment: cron hands the whole command to sh.
CRON_LINE = $(SCHEDULE) cd $(CURDIR) && docker compose run --rm labeller >> $(LOG) 2>&1 \# $(TAG)

.PHONY: help deploy cron-set cron-list cron-remove run

# First target, so it is what a bare `make` runs. It prints every target that has a "## text".
help: ## Show this list
	@awk -F ':.*## ' '/^[a-z-]+:.*## / { printf "  make %-12s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

deploy: ## Pull the latest code and rebuild the image
	git pull --ff-only
	docker compose build

cron-set: ## Install (or replace) the hourly crontab entry
	@( crontab -l 2>/dev/null | grep -vF '$(TAG)'; echo '$(CRON_LINE)' ) | crontab -
	@echo 'Installed:'
	@crontab -l | grep -F '$(TAG)'

cron-list: ## Show the current user's crontab
	@crontab -l 2>/dev/null || echo 'No crontab for $(shell whoami).'

cron-remove: ## Remove the crontab entry
	@( crontab -l 2>/dev/null | grep -vF '$(TAG)' ) | crontab -
	@echo 'Removed the $(TAG) entry.'

run: ## One run now, output to the terminal
	docker compose run --rm labeller
