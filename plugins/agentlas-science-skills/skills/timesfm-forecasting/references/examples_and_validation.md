# Forecast Input and Output Checks

Run scripts/check_system.py before loading the model. Use scripts/forecast_csv.py with a CSV supplied by the user; select its value column and a horizon appropriate to the task.

## Input checks

- Confirm the observations are ordered in time and represent the same frequency.
- Report missing values, the observed context length, units, and any transformation.
- Use matched covariate arrays when calling forecast_with_covariates.

## Output checks

- Confirm the point forecast contains the requested horizon and the quantile array matches the model version.
- Check for nonfinite values and use named quantile indices from references/output_and_config.md.
- Keep historical observations separate from forecasts in every exported table and plot.
- Compute accuracy and interval coverage only against held-out observations supplied for this task.
- Record the model version and configuration with the user's output.

For API configuration, plotting, and multi-series input, read references/output_and_config.md and references/workflows.md.
