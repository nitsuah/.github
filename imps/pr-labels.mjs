export function buildImpPrLabels(risk, riskLabel, needsHumanLabel) {
    const labels = ['imp', 'no-changelog', riskLabel];
    if (risk === 'high') labels.push(needsHumanLabel);
    return labels;
}
