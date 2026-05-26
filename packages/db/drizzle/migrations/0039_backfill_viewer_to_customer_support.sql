UPDATE project_members
SET role = 'CUSTOMER_SUPPORT', "updatedAt" = NOW()
WHERE role = 'VIEWER';
