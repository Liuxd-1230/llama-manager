# Llama Manager

## Product truth

Llama Manager is a Chinese-language web application for managing local inference servers on Windows. It supports llama.cpp, KVMem, and NInfer. Its six workspaces are models, configuration, run, evaluation, maintenance, and chat. Profiles connect model files to engine, inference, sampling, and prompt settings. The application launches and stops processes, shows logs, proxies chat, and manages evaluation jobs.

Source: the repository's AGENTS.md, existing backend/frontend implementation, and the user's approved interface work. No commercial positioning, market claims, or new engine behavior are implied by the design.

## Audience and usage

Confirmed scope: people configuring and using local inference engines on Windows. The interface must support technical parameters, file paths, launch commands, and resource estimates without requiring every detail to be visible at once. Keyboard navigation and narrow browser windows remain usable.

Inferred usage scene: a desktop workspace in which model setups are compared, edited, and run repeatedly. Beginner and expert roles are usability lenses, not validated market personas. No audience research or task-frequency research was performed.

## Core tasks

- Select or create a model profile, understand its current/running state, and launch it.
- Edit engine-specific parameters, inspect the command and resource estimate, and save deliberately.
- Monitor execution, converse with models, evaluate results, and maintain engine binaries/source.

Resource graphics communicate estimates, not live GPU telemetry. Existing 8 GB capacity and 7.4 GB safety-line assumptions come from the application's estimator and profile guide; changing those assumptions or tuning inference settings is outside this interface refinement.

## Approved visual commitments

The user rejected a conservative operations-dashboard direction and approved a contemporary, translucent desktop application with liquid glass, coral accents, spatial hierarchy, precise resource graphics, and short purposeful interactions. Preserve the incumbent identity, Chinese UI, both themes, and four accent options. Model identity and resource fit provide product character. Glass has a structural job in the floating shell and overlays; core work remains readable and immediately visible.

## Boundaries

Preserve configuration values, existing API semantics, engine behavior, and all existing controls. Advanced controls may be disclosed progressively. Confirm destructive operations; preserve user work when requests fail. Do not invent performance measurements, model images, commercial claims, or additional inference recommendations.
