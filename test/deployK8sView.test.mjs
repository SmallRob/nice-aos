// 部署蓝图 K8s 架构视图测试：
// 1. buildDeployModel 收集 k8sResources（工作负载 / Service / Ingress / ConfigMap / Secret / PVC 全覆盖，容器 env 不落明文）
// 2. buildDeployViewerModel 聚合 k8s 视图模型（present / 分类 / namespaces / kindCounts）
// 3. renderDeployOverviewHtml 条件渲染「K8s 架构」标签页（有 K8s 数据显示，无则不显示）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildDeployModel } from '../src/deployment/deployBuilder.js';
import { buildDeployViewerModel, renderDeployOverviewHtml } from '../src/deployment/deployViewer.js';

const K8S_MANIFEST = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: portal-backend
  namespace: asdm
spec:
  replicas: 2
  template:
    spec:
      containers:
        - name: portal-backend
          image: registry.example.com/admin/portal-backend:1.2.3
          ports:
            - containerPort: 8080
          env:
            - name: PLAIN_FLAG
              value: hello
            - name: DB_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: db-secret
                  key: password
          readinessProbe:
            httpGet:
              path: /health
              port: 8080
          resources:
            limits:
              cpu: 500m
              memory: 512Mi
---
apiVersion: v1
kind: Service
metadata:
  name: portal-backend
  namespace: asdm
spec:
  type: ClusterIP
  ports:
    - port: 80
      targetPort: 8080
  selector:
    app: portal-backend
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: portal-ingress
  namespace: asdm
spec:
  rules:
    - host: portal.example.com
      http:
        paths:
          - path: /
            backend:
              service:
                name: portal-backend
                port:
                  number: 80
`;

const K8S_CONFIG_MANIFEST = `apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
  namespace: asdm
data:
  LOG_LEVEL: info
  MAX_CONN: "100"
---
apiVersion: v1
kind: Secret
metadata:
  name: db-secret
  namespace: asdm
type: Opaque
data:
  password: c2VjcmV0LXZhbHVl
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: data-pvc
  namespace: asdm
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 10Gi
`;

const COMPOSE_ONLY = `services:
  web:
    image: nginx:1.25
    ports:
      - "8080:80"
`;

function withTempDir(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nice-aos-k8s-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), content, 'utf-8');
    }
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('buildDeployModel 收集全部 K8s 资源类型到 k8sResources', () => {
  withTempDir({
    '10-portal.yaml': K8S_MANIFEST,
    '20-config.yaml': K8S_CONFIG_MANIFEST,
  }, (dir) => {
    const model = buildDeployModel(dir);
    assert.equal(model._meta.k8sResourceCount, 6);
    const kinds = model.k8sResources.map((r) => r.kind).sort();
    assert.deepEqual(kinds, ['ConfigMap', 'Deployment', 'Ingress', 'PersistentVolumeClaim', 'Secret', 'Service']);

    const dep = model.k8sResources.find((r) => r.kind === 'Deployment');
    assert.equal(dep.name, 'portal-backend');
    assert.equal(dep.namespace, 'asdm');
    assert.equal(dep.replicas, 2);
    assert.equal(dep.source, '10-portal.yaml');
    assert.equal(dep.containers.length, 1);
    const c = dep.containers[0];
    assert.equal(c.image, 'registry.example.com/admin/portal-backend:1.2.3');
    // envCount 只统计明文 value（PLAIN_FLAG）；DB_PASSWORD 走 valueFrom → envRefs
    assert.equal(c.envCount, 1);
    // 容器 env 明文值不落 k8sResources（只有数量 + 引用关系）
    assert.equal(c.env, undefined);
    assert.equal(c.envRefs.length, 1);
    assert.equal(c.envRefs[0].ref, 'db-secret');
    assert.ok(c.readinessProbe);

    const svc = model.k8sResources.find((r) => r.kind === 'Service');
    assert.equal(svc.serviceType, 'ClusterIP');
    assert.deepEqual(svc.selector, { app: 'portal-backend' });

    const ing = model.k8sResources.find((r) => r.kind === 'Ingress');
    assert.equal(ing.paths[0].serviceName, 'portal-backend');

    const cm = model.k8sResources.find((r) => r.kind === 'ConfigMap');
    assert.equal(cm.dataKeyCount, 2);
    const pvc = model.k8sResources.find((r) => r.kind === 'PersistentVolumeClaim');
    assert.equal(pvc.storage, '10Gi');
    // Secret 只留键名统计，不留值
    const sec = model.k8sResources.find((r) => r.kind === 'Secret');
    assert.equal(sec.dataKeyCount, 1);
    assert.ok(!JSON.stringify(sec).includes('c2VjcmV0'));
  });
});

test('无 K8s manifest 时 k8sResources 为空且 meta 计数为 0', () => {
  withTempDir({ 'docker-compose.yml': COMPOSE_ONLY }, (dir) => {
    const model = buildDeployModel(dir);
    assert.deepEqual(model.k8sResources, []);
    assert.equal(model._meta.k8sResourceCount, 0);
    const vm = buildDeployViewerModel(model);
    assert.equal(vm.k8s.present, false);
    const html = renderDeployOverviewHtml(vm);
    assert.ok(!html.includes('data-tab="k8s"'));
    assert.ok(!html.includes('id="view-k8s"'));
  });
});

test('buildDeployViewerModel 聚合 K8s 视图模型分类与命名空间', () => {
  withTempDir({
    '10-portal.yaml': K8S_MANIFEST,
    '20-config.yaml': K8S_CONFIG_MANIFEST,
  }, (dir) => {
    const vm = buildDeployViewerModel(buildDeployModel(dir));
    assert.equal(vm.k8s.present, true);
    assert.equal(vm.k8s.total, 6);
    assert.equal(vm.k8s.workloads.length, 1);
    assert.equal(vm.k8s.services.length, 1);
    assert.equal(vm.k8s.ingresses.length, 1);
    assert.equal(vm.k8s.configs.length, 2);
    assert.equal(vm.k8s.storage.length, 1);
    assert.deepEqual(vm.k8s.namespaces, ['asdm']);
    assert.equal(vm.meta.k8sResourceCount, 6);
  });
});

test('部署蓝图含 K8s 数据时渲染「K8s 架构」标签页，无则隐藏', () => {
  withTempDir({
    '10-portal.yaml': K8S_MANIFEST,
    '20-config.yaml': K8S_CONFIG_MANIFEST,
    'docker-compose.yml': COMPOSE_ONLY,
  }, (dir) => {
    const vm = buildDeployViewerModel(buildDeployModel(dir));
    const html = renderDeployOverviewHtml(vm);
    assert.ok(html.includes('<button class="tab-btn" data-tab="k8s">K8s 架构</button>'));
    assert.ok(html.includes('id="view-k8s"'));
    assert.ok(html.includes('k8s-workloads'));
    assert.ok(html.includes('k8s-services'));
    assert.ok(html.includes('k8s-ingresses'));
    assert.ok(html.includes('k8s-configs'));
    assert.ok(html.includes('function renderK8s()'));
    // K8s 视图数据内嵌（含 namespace / kind）
    assert.ok(html.includes('"namespace":"asdm"'));
    assert.ok(html.includes('"kind":"Deployment"'));

    // 负例：仅 compose 的 viewmodel 不渲染 K8s 标签
    const vmNoK8s = buildDeployViewerModel({
      _meta: { sourceDir: '/x/deploy', scannedAt: '2026-08-31T00:00:00Z', fileCount: 1, serviceCount: 1 },
      services: [{ name: 'web', type: 'frontend', layer: 'frontend', ports: [], containerPorts: [80], env: {}, envRefs: [], configRefs: [], dependsOn: [], volumes: [], networks: [], sources: [], middleware: null }],
      routes: [], upstreams: [], dependencies: [], middleware: [], environments: [], files: [], layers: [],
    });
    const htmlNoK8s = renderDeployOverviewHtml(vmNoK8s);
    assert.ok(!htmlNoK8s.includes('data-tab="k8s"'));
    assert.ok(!htmlNoK8s.includes('id="view-k8s"'));
  });
});
